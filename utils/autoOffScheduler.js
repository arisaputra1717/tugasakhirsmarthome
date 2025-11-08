const cron = require("node-cron");
const moment = require("moment-timezone");
const { Op } = require("sequelize");
const { Perangkat, AktivasiManual, Penjadwalan } = require("../models");
const { publishKontrol } = require("../mqttClient"); // helper dari mqttClient

cron.schedule(
  "* * * * *",
  async () => {
    try {
      const now = moment().tz("Asia/Jakarta");
      const todayStr = now.format("YYYY-MM-DD");
      const hhmmss = now.format("HH:mm:ss");

      console.log(`⏰ [Cron] Pengecekan auto-ON/OFF (${now.format("YYYY-MM-DD HH:mm:ss")})`);

      // ==========================
      // 1️⃣ AUTO-OFF untuk entri bertimer (Manual-OnTimer & Rekomendasi)
      // ==========================
      const due = await AktivasiManual.findAll({
        where: {
          tipe: { [Op.in]: ["Manual-OnTimer", "Rekomendasi"] },
          tanggal_selesai: { [Op.lte]: todayStr },
          jam_selesai: { [Op.lte]: hhmmss },
        },
        include: [Perangkat],
      });

      for (const a of due) {
        const dev = a.Perangkat;
        if (!dev) continue;

        await dev.update({ status: "OFF" });
        if (dev.topik_kontrol) publishKontrol(dev.topik_kontrol, "OFF");
        console.log(`⏱ Auto-OFF ${a.tipe}: ${dev.nama_perangkat} (selesai ${a.tanggal_selesai} ${a.jam_selesai})`);

        await a.update({ tipe: `${a.tipe}-Completed` });
      }

      // ==========================
      // 2️⃣ AUTO-ON / AUTO-OFF berdasarkan jadwal aktif
      // ==========================
      const jadwalAktif = await Penjadwalan.findAll({
        where: {
          aktif: true,
          tanggal_mulai: { [Op.lte]: todayStr },
          tanggal_selesai: { [Op.gte]: todayStr },
        },
      });

      for (const jadwal of jadwalAktif) {
        const startTime = moment.tz(`${todayStr} ${jadwal.jam_mulai}`, "YYYY-MM-DD HH:mm:ss", "Asia/Jakarta");
        const endTime = moment.tz(`${todayStr} ${jadwal.jam_selesai}`, "YYYY-MM-DD HH:mm:ss", "Asia/Jakarta");

        const perangkat = await Perangkat.findByPk(jadwal.perangkat_id);
        if (!perangkat) continue;

        // Auto-OFF Jadwal
        if (perangkat.status === "ON" && now.isSameOrAfter(endTime)) {
          await perangkat.update({ status: "OFF" });
          if (jadwal.status) await jadwal.update({ status: "OFF" });
          if (perangkat.topik_kontrol) publishKontrol(perangkat.topik_kontrol, "OFF");
          console.log(`⏱ Auto-OFF Jadwal: ${perangkat.nama_perangkat} (selesai ${endTime.format("YYYY-MM-DD HH:mm:ss")})`);
        }

        // Auto-ON Jadwal
        if (perangkat.status === "OFF" && now.isSameOrAfter(startTime) && now.isBefore(endTime)) {
          await perangkat.update({ status: "ON" });
          if (!jadwal.status) await jadwal.update({ status: "ON" });
          if (perangkat.topik_kontrol) publishKontrol(perangkat.topik_kontrol, "ON");
          console.log(`✅ Auto-ON Jadwal: ${perangkat.nama_perangkat} (mulai ${startTime.format("YYYY-MM-DD HH:mm:ss")})`);
        }
      }

      // ==========================
      // 3️⃣ Nonaktifkan jadwal yang sudah lewat
      // ==========================
      const semuaJadwal = await Penjadwalan.findAll({ where: { aktif: true } });
      for (const jadwal of semuaJadwal) {
        const endDatetime = moment.tz(
          `${jadwal.tanggal_selesai} ${jadwal.jam_selesai}`,
          "YYYY-MM-DD HH:mm:ss",
          "Asia/Jakarta"
        );

        if (now.isSameOrAfter(endDatetime)) {
          await jadwal.update({ aktif: false, status: "OFF" });

          const perangkat = await Perangkat.findByPk(jadwal.perangkat_id);
          if (perangkat) {
            await perangkat.update({ status: "OFF" });
            if (perangkat.topik_kontrol) publishKontrol(perangkat.topik_kontrol, "OFF");
          }

          console.log(`📅 Jadwal ID ${jadwal.id} dinonaktifkan (lewat tanggal & jam selesai)`);
        }
      }
    } catch (error) {
      console.error("❌ Cron Auto-ON/OFF error:", error);
    }
  },
  { timezone: "Asia/Jakarta" }
);
