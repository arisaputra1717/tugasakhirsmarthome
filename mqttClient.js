// mqttClient.js — debug-ready (ENERGY MODE)
require("dotenv").config();
const mqtt = require("mqtt");
const { Op } = require("sequelize");
const moment = require("moment-timezone");
const { Perangkat, DataPenggunaan, LimitEnergi } = require("./models");

const TZ = "Asia/Jakarta";

const BROKER = process.env.MQTT_BROKER || "mqtt://192.168.18.116:1883";
console.log("MQTT client starting. Broker:", BROKER);

// connect
const client = mqtt.connect(BROKER, {
  clientId: "smart-energy-client-" + Math.random().toString(16).substr(2, 8),
  clean: true,
  connectTimeout: 4000,
  reconnectPeriod: 1000,
  username: process.env.MQTT_USER || undefined,
  password: process.env.MQTT_PASS || undefined,
  protocolId: "MQTT",
  protocolVersion: 4,
  keepalive: 60,
  rejectUnauthorized: false,
});

function publishKontrol(topic, status, retain = true) {
  if (!topic) return;
  try {
    const st = String(status).toUpperCase();

    // 1) JSON modern (dipakai UI/simulator): { status: "ON" }
    // 2) Kompatibilitas lama/ESP: { command: "ON" }
    // 3) Plain fallback: "ON"
    const payloadJson = JSON.stringify({ status: st, command: st });
    // publish JSON
    client.publish(topic, payloadJson, { qos: 1, retain }, (err) => {
      if (err) {
        console.error("❌ Publish kontrol (JSON) gagal:", topic, err.message);
      } else {
        console.log(`➡️ Publish kontrol JSON to ${topic}: ${payloadJson}`);
      }
    });

    // also publish plain string shortly after as fallback for clients that expect raw "ON"/"OFF"
    setTimeout(() => {
      client.publish(topic, st, { qos: 1, retain: false }, (err) => {
        if (err) console.error("❌ Publish kontrol (plain) gagal:", topic, err.message);
        else console.log(`➡️ Publish kontrol PLAIN to ${topic}: ${st}`);
      });
    }, 120); // delay small so broker processes JSON first

  } catch (e) {
    console.error("❌ Gagal kirim kontrol:", e.message);
  }
}

module.exports = client;
module.exports.publishKontrol = publishKontrol;

// on connect
client.on("connect", async () => {
  console.log("✅ Terhubung ke MQTT broker (server) ->", BROKER);
  try {
    const perangkatList = await Perangkat.findAll();
    console.log(`→ Found ${perangkatList.length} perangkat in DB`);
    for (const { topik_mqtt, nama_perangkat } of perangkatList) {
      const topic = (topik_mqtt || "").trim();
      if (!topic) {
        console.warn(`⚠️ Perangkat "${nama_perangkat}" tidak punya topik_mqtt`);
        continue;
      }
      console.log(`📡 Attempt subscribe "${topic}" for ${nama_perangkat}`);
      client.subscribe(topic, { qos: 1 }, (err) => {
        if (err) console.error(`❌ Gagal subscribe "${topic}":`, err.message);
        else console.log(`✅ Subscribed: "${topic}"`);
      });
    }
  } catch (err) {
    console.error("❌ Gagal ambil perangkat:", err.message);
  }
});

client.on("error", (e) => {
  console.error("MQTT client error:", e && e.message ? e.message : e);
});

// message handler (debug + original processing)
client.on("message", async (topic, message) => {
  const txt = message.toString();
  console.log(`🛰️ MQTT message received on topic=${topic} payload=${txt.slice(0,400)}`);

  let data;
  try {
    data = JSON.parse(txt);
  } catch (e) {
    return console.warn(`⚠️ Data bukan JSON dari ${topic} -> ${e.message}`);
  }

  if ("command" in data) {
    // ignore control messages in this handler (or handle if needed)
    return console.log(`ℹ️ Control message ignored on ${topic}`);
  }

  const valid = ["volt", "ampere", "watt", "energy"].every((k) => typeof data[k] === "number");
  if (!valid) return console.warn(`⚠️ Data tidak valid dari ${topic} (${Object.keys(data).join(",")})`);

  // find device
  const perangkat = await Perangkat.findOne({ where: { topik_mqtt: topic } });
  if (!perangkat) {
    console.warn(`⚠️ Tidak ditemukan perangkat untuk ${topic} — cek topik_mqtt di DB`);
    return;
  }

  try {
    const now = moment().tz(TZ);
    const nowDate = now.toDate();

    const prev = await DataPenggunaan.findOne({
      where: { perangkat_id: perangkat.id },
      order: [["timestamp", "DESC"]],
    });

    const energyPrev = prev?.energy ?? null;
    const energyDelta = energyPrev == null ? 0 : Math.max(0, data.energy - energyPrev);

    await DataPenggunaan.create({
      perangkat_id: perangkat.id,
      volt: data.volt,
      ampere: data.ampere,
      watt: data.watt,
      energy: data.energy,
      energy_delta: energyDelta,
      timestamp: nowDate,
    });

    // limit check
    const todayStr = now.format("YYYY-MM-DD");
    const limit = await LimitEnergi.findOne({
      where: {
        tanggal_mulai: { [Op.lte]: todayStr },
        tanggal_selesai: { [Op.gte]: todayStr },
      },
      order: [["id", "DESC"]],
    });
    const hasLimit = !!limit;

    if (hasLimit) {
      const statusOn = String(perangkat.status || "").toUpperCase() === "ON";
      const dayaWatt = Number(perangkat.daya_watt) || 0;

      if (statusOn && dayaWatt > 0 && energyDelta > 0) {
        const deltaJam = (energyDelta * 1000) / dayaWatt;
        const durasiLama = Number(perangkat.durasi_terpakai) || 0;
        let durasiBaru = durasiLama + deltaJam;

        const kuota = perangkat.kuota_durasi != null ? Number(perangkat.kuota_durasi) : 0;
        let habis = false;
        if (kuota > 0 && durasiBaru >= kuota) {
          durasiBaru = kuota;
          habis = true;
        }

        await perangkat.update({ durasi_terpakai: Number(durasiBaru.toFixed(4)) });

        if (global.io) {
          const persen = kuota > 0 ? Math.min(100, Math.round((durasiBaru / kuota) * 100)) : 0;
          global.io.emit("durasi-update", {
            id: perangkat.id,
            durasi: Number(durasiBaru.toFixed(2)),
            kuota: kuota || null,
            persen,
          });
        }

        if (habis && perangkat.status === "ON") {
          await perangkat.update({ status: "OFF" });
          if (perangkat.topik_kontrol) publishKontrol(perangkat.topik_kontrol, "OFF");
          console.log(`⛔ Kuota habis → OFF: ${perangkat.nama_perangkat}`);
          if (global.io) global.io.emit("status-updated", { id: perangkat.id, status: "OFF" });
        }
      } else {
        // debug: why not updating?
        if (!statusOn) console.log(`ℹ️ Perangkat ${perangkat.nama_perangkat} tidak ON => tidak menambah durasi`);
        if (dayaWatt <= 0) console.log(`⚠️ Perangkat ${perangkat.nama_perangkat} daya_watt=${dayaWatt} => tidak menambah durasi`);
        if (energyDelta <= 0) console.log(`⚠️ energyDelta=${energyDelta} => tidak menambah durasi`);
      }
    } // end hasLimit

    // totalToday
    const startOfDay = moment().tz(TZ).startOf("day").toDate();
    let totalToday = await DataPenggunaan.sum("energy_delta", {
      where: { timestamp: { [Op.gte]: startOfDay } },
    });
    totalToday = Number.isFinite(totalToday) ? totalToday : 0;

    // emit dashboard
    if (global.io) {
      if (hasLimit && Number(limit.batas_kwh) > 0) {
        const persenLimit = Math.max(0, Math.min(100, Math.round((totalToday / Number(limit.batas_kwh)) * 100)));
        global.io.emit("limit-updated", {
          totalEnergi: Number(totalToday.toFixed(2)),
          limit: { batas_kwh: Number(limit.batas_kwh), tanggal_mulai: limit.tanggal_mulai, tanggal_selesai: limit.tanggal_selesai },
          persenLimit,
        });
        if (persenLimit >= 100) {
          console.log("🚨 LIMIT 100% TERCAPAI — Matikan semua perangkat");
          const ons = await Perangkat.findAll({ where: { status: "ON" } });
          for (const p of ons) {
            await p.update({ status: "OFF" });
            if (p.topik_kontrol) publishKontrol(p.topik_kontrol, "OFF");
            console.log(`⛔ OFF: ${p.nama_perangkat}`);
            if (global.io) global.io.emit("status-updated", { id: p.id, status: "OFF" });
          }
          if (global.io) global.io.emit("limit-energi-full", { persen: 100 });
        }
      } else {
        global.io.emit("limit-updated", { totalEnergi: Number(totalToday.toFixed(2)), limit: null, persenLimit: 0 });
      }

      global.io.emit("data-terbaru", {
        perangkat_id: perangkat.id,
        nama_perangkat: perangkat.nama_perangkat,
        volt: data.volt,
        ampere: data.ampere,
        watt: data.watt,
        energy: data.energy,
        energy_delta: energyDelta,
        timestamp: nowDate.toISOString(),
        penjadwalan_aktif: perangkat.penjadwalan_aktif ?? null,
        skor_prioritas: perangkat.skor_prioritas ?? null,
      });

      global.io.emit("totalEnergiUpdate", { total: totalToday.toFixed(2) });
    }
  } catch (err) {
    console.error(`❌ Gagal memproses data dari "${perangkat?.nama_perangkat || topic}":`, err.message);
  }
});

