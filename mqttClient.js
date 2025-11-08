// mqttClient.js — ENERGY MODE siap pakai
require("dotenv").config();
const mqtt = require("mqtt");
const { Op } = require("sequelize");
const moment = require("moment-timezone");
const { Perangkat, DataPenggunaan, LimitEnergi } = require("./models");

const TZ = "Asia/Jakarta";

// ====== MQTT CONNECT ======
const client = mqtt.connect(
  process.env.MQTT_BROKER || "mqtt://broker.emqx.io:1883",
  {
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
  }
);

// publish helper {status:"ON"/"OFF"}
function publishKontrol(topic, status, retain = true) {
  if (!topic) return;
  try {
    const payload = JSON.stringify({ status: String(status).toUpperCase() });
    client.publish(topic, payload, { qos: 1, retain }, (err) => {
      if (err) console.error("❌ Publish kontrol gagal:", topic, err.message);
    });
  } catch (e) {
    console.error("❌ Gagal kirim kontrol:", e.message);
  }
}

module.exports = client;
module.exports.publishKontrol = publishKontrol;

// ====== ON CONNECT: subscribe topik device ======
client.on("connect", async () => {
  console.log("✅ Terhubung ke MQTT broker");

  try {
    const perangkatList = await Perangkat.findAll();
    for (const { topik_mqtt, nama_perangkat } of perangkatList) {
      const topic = topik_mqtt?.trim();
      if (!topic) {
        console.warn(`⚠️ Perangkat "${nama_perangkat}" tidak punya topik_mqtt`);
        continue;
      }
      client.subscribe(topic, (err) => {
        if (err) console.error(`❌ Gagal subscribe "${topic}":`, err.message);
        else console.log(`📡 Subscribe: "${topic}"`);
      });
    }
  } catch (err) {
    console.error("❌ Gagal ambil perangkat:", err.message);
  }
});

// ====== MESSAGE HANDLER (ENERGY MODE) ======
client.on("message", async (topic, message) => {
  // 0) parse payload
  let data;
  try {
    data = JSON.parse(message.toString());
  } catch {
    return console.warn(`⚠️ Data bukan JSON dari ${topic}`);
  }

  // abaikan pesan kontrol
  if ("command" in data) return;

  const valid = ["volt", "ampere", "watt", "energy"].every(
    (k) => typeof data[k] === "number"
  );
  if (!valid) return console.warn(`⚠️ Data tidak valid dari ${topic}`);

  // 1) temukan perangkat
  const perangkat = await Perangkat.findOne({ where: { topik_mqtt: topic } });
  if (!perangkat) return console.warn(`⚠️ Tidak ditemukan perangkat untuk ${topic}`);

  try {
    const now = moment().tz(TZ);
    const nowDate = now.toDate();

    // 2) simpan telemetry & hitung energyDelta (kWh)
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
      energy: data.energy,       // kumulatif kWh dari PZEM/simulator
      energy_delta: energyDelta, // kWh (selisih)
      timestamp: nowDate,
    });

    // 3) cek limit aktif (guard untuk akumulasi durasi_terpakai)
    const todayStr = now.format("YYYY-MM-DD");
    const limit = await LimitEnergi.findOne({
      where: {
        tanggal_mulai: { [Op.lte]: todayStr },
        tanggal_selesai: { [Op.gte]: todayStr },
      },
      order: [["id", "DESC"]],
    });
    const hasLimit = !!limit;

    // 4) ENERGY MODE: tambah durasi_terpakai kalau ADA LIMIT & device ON & ∆E > 0 & daya_watt > 0
    if (hasLimit) {
      const statusOn = String(perangkat.status || "").toUpperCase() === "ON";
      const dayaWatt = Number(perangkat.daya_watt) || 0;

      if (statusOn && dayaWatt > 0 && energyDelta > 0) {
        // Waktu (jam) = (kWh * 1000) / Watt
        const deltaJam = (energyDelta * 1000) / dayaWatt;

        // gunakan 4 desimal simpanan; tampilkan 2 desimal di UI saja
        const durasiLama = Number(perangkat.durasi_terpakai) || 0;
        let durasiBaru = durasiLama + deltaJam;

        // batasi oleh kuota jika kuota > 0
        const kuota = perangkat.kuota_durasi != null ? Number(perangkat.kuota_durasi) : 0;
        let habis = false;
        if (kuota > 0 && durasiBaru >= kuota) {
          durasiBaru = kuota;
          habis = true;
        }

        // simpan (4 desimal agar akumulasi halus)
        await perangkat.update({
          durasi_terpakai: Number(durasiBaru.toFixed(4)),
        });

        // emit progres ke UI (opsional)
        if (global.io) {
          const persen =
            kuota > 0 ? Math.min(100, Math.round((durasiBaru / kuota) * 100)) : 0;
          global.io.emit("durasi-update", {
            id: perangkat.id,
            durasi: Number(durasiBaru.toFixed(2)), // tampil 2 des
            kuota: kuota || null,
            persen,
          });
        }

        // auto OFF jika kuota habis
        if (habis && perangkat.status === "ON") {
          await perangkat.update({ status: "OFF" });
          if (perangkat.topik_kontrol) publishKontrol(perangkat.topik_kontrol, "OFF");
          console.log(`⛔ Kuota habis → OFF: ${perangkat.nama_perangkat}`);
          if (global.io) global.io.emit("status-updated", { id: perangkat.id, status: "OFF" });
        }
      }
      // catatan: bila energyDelta==0 (simulator tidak menaikkan energy), durasi memang tidak bertambah — ini sesuai energy mode
    }
    // ❗ Tidak ada limit → JANGAN ubah durasi_terpakai di sini.
    // Reset ke 0 sudah ditangani saat hapus limit (di limitController.destroy)

    // 5) hitung total energi hari ini (progress bar dashboard)
    const startOfDay = moment().tz(TZ).startOf("day").toDate();
    let totalToday = await DataPenggunaan.sum("energy_delta", {
      where: { timestamp: { [Op.gte]: startOfDay } },
    });
    totalToday = Number.isFinite(totalToday) ? totalToday : 0;

    // 6) emit untuk dashboard (progress bar & total pemakaian)
    if (global.io) {
      if (hasLimit && Number(limit.batas_kwh) > 0) {
        const persenLimit = Math.max(
          0,
          Math.min(100, Math.round((totalToday / Number(limit.batas_kwh)) * 100))
        );

        global.io.emit("limit-updated", {
          totalEnergi: Number(totalToday.toFixed(2)),
          limit: {
            batas_kwh: Number(limit.batas_kwh),
            tanggal_mulai: limit.tanggal_mulai,
            tanggal_selesai: limit.tanggal_selesai,
          },
          persenLimit,
        });

        // cut-off 100%: matikan semua perangkat
        if (persenLimit >= 100) {
          console.log("🚨 LIMIT 100% TERCAPAI — Matikan semua perangkat");
          const ons = await Perangkat.findAll({ where: { status: "ON" } });
          for (const p of ons) {
            await p.update({ status: "OFF" });
            if (p.topik_kontrol) publishKontrol(p.topik_kontrol, "OFF");
            console.log(`⛔ OFF: ${p.nama_perangkat}`);
            global.io.emit("status-updated", { id: p.id, status: "OFF" });
          }
          global.io.emit("limit-energi-full", { persen: 100 });
        }
      } else {
        // tanpa limit aktif → progress 0, tapi tetap kirim total energi
        global.io.emit("limit-updated", {
          totalEnergi: Number(totalToday.toFixed(2)),
          limit: null,
          persenLimit: 0,
        });
      }

      // telemetry realtime per perangkat
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

      // kompat lama
      global.io.emit("totalEnergiUpdate", { total: totalToday.toFixed(2) });
    }
  } catch (err) {
    console.error(
      `❌ Gagal memproses data dari "${perangkat?.nama_perangkat || topic}":`,
      err.message
    );
  }
});
