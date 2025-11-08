const { Perangkat, AktivasiManual } = require("../models");
const { Op } = require("sequelize");
const moment = require("moment-timezone");
const { publishKontrol } = require("../mqttClient");

const TZ = "Asia/Jakarta";

async function resumePausedDevices() {
  const now = moment().tz(TZ);
  const hhmmss = now.format("HH:mm:ss");
  const ymd = now.format("YYYY-MM-DD");

  // 1) Resume perangkat yang di-Pause → ON kembali
  const paused = await AktivasiManual.findAll({
    where: {
      tipe: "Pause",
      jam_selesai: { [Op.lte]: hhmmss },
      tanggal_selesai: { [Op.lte]: ymd },
    },
    include: [Perangkat],
  });

  for (const p of paused) {
    if (!p.Perangkat) continue;
    const perangkat = p.Perangkat;

    await perangkat.update({ status: "ON" });
    if (perangkat.topik_kontrol) publishKontrol(perangkat.topik_kontrol, "ON");

    console.log(`🔄 Resume perangkat (Pause selesai): ${perangkat.nama_perangkat}`);
    await p.update({ tipe: "Pause-Completed" });
  }

  // 2) Matikan perangkat yang ON karena Rekomendasi → OFF kembali
  const rekom = await AktivasiManual.findAll({
    where: {
      tipe: "Rekomendasi",
      jam_selesai: { [Op.lte]: hhmmss },
      tanggal_selesai: { [Op.lte]: ymd },
    },
    include: [Perangkat],
  });

  for (const r of rekom) {
    if (!r.Perangkat) continue;
    const perangkat = r.Perangkat;

    await perangkat.update({ status: "OFF" });
    if (perangkat.topik_kontrol) publishKontrol(perangkat.topik_kontrol, "OFF");

    console.log(`⏹️ Matikan perangkat (Rekomendasi selesai): ${perangkat.nama_perangkat}`);
    await r.update({ tipe: "Rekomendasi-Completed" });
  }
}

module.exports = resumePausedDevices;
