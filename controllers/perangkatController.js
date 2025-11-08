// controllers/perangkatController.js
const {
  Perangkat,
  DataPenggunaan,
  Penjadwalan,
  AktivasiManual,
} = require("../models");
const moment = require("moment-timezone");
const { Sequelize, Op } = require("sequelize");
const { fuzzyPrioritas } = require("../utils/fuzzyLogic");
const { hitungWFSHybrid } = require("../services/wfsServices");
const { simulateAndRecommendDynamic } = require("../services/recommender");
const { cekBebanPuncak } = require("../services/DashboardService");
const { publishKontrol } = require("../mqttClient");

const TZ = "Asia/Jakarta";

// ===============================================================
// TAMPILKAN SEMUA PERANGKAT
// ===============================================================
exports.index = async (req, res) => {
  try {
    const perangkat = await Perangkat.findAll();
    res.render("perangkat/index", { title: "Perangkat", perangkat });
  } catch (err) {
    console.error("❌ Gagal mengambil data perangkat:", err.message);
    res.status(500).send("Gagal mengambil data perangkat");
  }
};

// ===============================================================
// FORM TAMBAH
// ===============================================================
exports.createForm = (req, res) => {
  res.render("perangkat/create");
};

// ===============================================================
// PROSES TAMBAH PERANGKAT
// ===============================================================
exports.create = async (req, res) => {
  try {
    const {
      nama_perangkat,
      topik_mqtt,
      topik_kontrol,
      daya_watt,
      durasi_jam,
      tipe,
    } = req.body;

    // Cegah duplikat
    const existing = await Perangkat.findOne({ where: { nama_perangkat } });
    if (existing)
      return res.status(400).json({
        status: "error",
        message: "Nama perangkat sudah digunakan",
      });

    // Fuzzy logic → skor prioritas
    const hasilFuzzy = fuzzyPrioritas(durasi_jam, daya_watt) || {};
    const skorPrioritas = parseFloat(
      (hasilFuzzy.skorPrioritas ?? 0).toFixed(4)
    );

    const data = {
      nama_perangkat,
      topik_mqtt,
      topik_kontrol: topik_kontrol || null,
      daya_watt: parseFloat(daya_watt) || 0,
      durasi_jam: parseFloat(durasi_jam) || 0,
      tipe,
      skor_prioritas: skorPrioritas,
      status: "OFF",
    };

    await Perangkat.create(data);
    console.log(`✅ Perangkat "${data.nama_perangkat}" berhasil dibuat`);

    // Re-hitung WFS
    await hitungWFSHybrid(new Date());

    return res.json({
      status: "success",
      message: "Perangkat berhasil ditambahkan",
    });
  } catch (err) {
    console.error("❌ Gagal membuat perangkat:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
};

// ===============================================================
// FORM EDIT
// ===============================================================
exports.editForm = async (req, res) => {
  try {
    const perangkat = await Perangkat.findByPk(req.params.id);
    if (!perangkat) return res.status(404).send("Perangkat tidak ditemukan");
    res.render("perangkat/edit", { perangkat });
  } catch (err) {
    console.error("❌ Gagal mengambil data perangkat untuk edit:", err.message);
    res.status(500).send("Gagal mengambil data perangkat");
  }
};

// ===============================================================
// PROSES EDIT
// ===============================================================
exports.edit = async (req, res) => {
  try {
    const perangkat = await Perangkat.findByPk(req.params.id);
    if (!perangkat)
      return res
        .status(404)
        .json({ status: "error", message: "Perangkat tidak ditemukan" });

    const {
      nama_perangkat,
      topik_mqtt,
      topik_kontrol,
      daya_watt,
      durasi_jam,
      tipe,
      status,
    } = req.body;

    const existing = await Perangkat.findOne({
      where: {
        nama_perangkat,
        id: { [Sequelize.Op.ne]: perangkat.id },
      },
    });
    if (existing)
      return res.status(400).json({
        status: "error",
        message: "Nama perangkat sudah digunakan",
      });

    const hasilFuzzy = fuzzyPrioritas(durasi_jam, daya_watt) || {};
    const skorPrioritas = parseFloat(
      (hasilFuzzy.skorPrioritas ?? 0).toFixed(4)
    );

    await hitungWFSHybrid(new Date());

    const data = {
      nama_perangkat,
      topik_mqtt,
      topik_kontrol: topik_kontrol || null,
      daya_watt: parseFloat(daya_watt) || 0,
      durasi_jam: parseFloat(durasi_jam) || 0,
      tipe,
      skor_prioritas: skorPrioritas,
      status: status || perangkat.status,
    };

    await perangkat.update(data);

    console.log(`✅ Perangkat "${data.nama_perangkat}" berhasil diupdate`);
    return res.json({
      status: "success",
      message: "Perangkat berhasil diupdate",
    });
  } catch (err) {
    console.error("❌ Gagal update perangkat:", err.message);
    res.status(500).json({ status: "error", message: err.message });
  }
};

// ===============================================================
// HAPUS
// ===============================================================
exports.delete = async (req, res) => {
  try {
    const perangkat = await Perangkat.findByPk(req.params.id);
    if (!perangkat)
      return res.json({ status: "error", message: "Perangkat tidak ditemukan" });

    const nama = perangkat.nama_perangkat;
    await DataPenggunaan.destroy({ where: { perangkat_id: req.params.id } });
    await Penjadwalan.destroy({ where: { perangkat_id: req.params.id } });
    await perangkat.destroy();

    console.log(`✅ Perangkat "${nama}" dihapus`);
    return res.json({
      status: "success",
      message: `Perangkat "${nama}" berhasil dihapus`,
    });
  } catch (err) {
    console.error("❌ Gagal hapus perangkat:", err.message);
    res.json({ status: "error", message: err.message });
  }
};

// ===============================================================
// CEK REKOMENDASI
// ===============================================================
exports.checkRecommendation = async (req, res) => {
  try {
    const requestedSchedules = req.body;
    const result = await simulateAndRecommendDynamic(requestedSchedules);
    res.json(result);
  } catch (err) {
    console.error("❌ Error checkRecommendation:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
};

// ===============================================================
// TOGGLE (ON / OFF) — lengkap
// ===============================================================
// ==========================
// GANTI fungsi toggle berikut ke controllers/perangkatController.js
// ==========================
exports.toggle = async (req, res) => {
  console.log("🔥 TOGGLE dipanggil");
  const { id } = req.params;
  const { status, tanggal, jamMenit, confirm, durasi } = req.body;

  try {
    const perangkat = await Perangkat.findByPk(id);
    if (!perangkat)
      return res
        .status(404)
        .json({ success: false, message: "Perangkat tidak ditemukan" });

    const state = String(status).toUpperCase();
    if (!["ON", "OFF"].includes(state))
      return res.status(400).json({ success: false, message: "Status tidak valid" });

    if (!tanggal || jamMenit === undefined)
      return res.status(400).json({ success: false, message: "Tanggal dan jam harus disertakan" });

    // ================= ON =================
    if (state === "ON") {
      console.log(`➡️ Request -> ON : ${perangkat.nama_perangkat} (${perangkat.id})`);

      const rekomendasi = await cekBebanPuncak(perangkat.daya_watt);
      if (!rekomendasi.rekomendasi.bisaLangsung && !confirm) {
        return res.json({
          success: false,
          title: "Tidak bisa menyalakan",
          message: "Perangkat melebihi kapasitas sistem.",
          rekomendasi: rekomendasi.rekomendasi,
        });
      }

      // attempt publish to device if topic exists; if fails => rollback / respond error
      let publishedOk = false;
      if (perangkat.topik_kontrol) {
        try {
          // publishKontrol mungkin sync atau async -> wrap dengan Promise.resolve
          await Promise.resolve(publishKontrol(perangkat.topik_kontrol, "ON"));
          publishedOk = true;
          console.log(`✅ publishKontrol ON success -> ${perangkat.topik_kontrol}`);
        } catch (pubErr) {
          console.error(`❌ publishKontrol ON failed for ${perangkat.nama_perangkat}:`, pubErr.message || pubErr);
          // Kembalikan error ke UI, jangan ubah status DB
          return res.status(500).json({
            success: false,
            message: "Gagal mengirim perintah ke perangkat (MQTT). Cek log server.",
            error: pubErr.message || String(pubErr),
          });
        }
      } else {
        // tidak ada topik kontrol -> tetap update DB (as before)
        publishedOk = true;
        console.warn(`⚠️ Perangkat "${perangkat.nama_perangkat}" tidak punya topik_kontrol — update status hanya di DB`);
      }

      // update status di DB setelah publish berhasil (atau tidak butuh topik_kontrol)
      await perangkat.update({ status: "ON" });

      const durasiMenit = Number(durasi || 0);
      if (durasiMenit > 0) {
        const jamMulai = moment.tz(`${tanggal} ${jamMenit}`, "YYYY-MM-DD HH:mm", TZ);
        const jamSelesai = jamMulai.clone().add(durasiMenit, "minutes");

        const aktif = await AktivasiManual.findOne({
          where: { perangkat_id: perangkat.id, jam_selesai: null },
          order: [["id", "DESC"]],
        });
        if (!aktif) {
          await AktivasiManual.create({
            perangkat_id: perangkat.id,
            tanggal_mulai: jamMulai.format("YYYY-MM-DD"),
            jam_mulai: jamMulai.format("HH:mm:ss"),
            tanggal_selesai: jamSelesai.format("YYYY-MM-DD"),
            jam_selesai: jamSelesai.format("HH:mm:ss"),
            durasi_menit: durasiMenit,
            tipe: "Manual-OnTimer",
          });
        }
      }

      // Pause perangkat lain bila perlu (tetap seperti semula) — ini men-trigger publish OFF juga
      if (confirm && rekomendasi.rekomendasi.perangkatPause?.length) {
        const now = moment().tz(TZ);
        const selesai = now.clone().add(Number(durasi || 0), "minutes");

        for (const p of rekomendasi.rekomendasi.perangkatPause) {
          const dev = await Perangkat.findByPk(p.id);
          if (dev && dev.status === "ON") {
            // publish OFF ke masing-masing perangkat (tunggu result, tapi jangan gagalkan seluruh proses bila satu gagal)
            try {
              if (dev.topik_kontrol) {
                await Promise.resolve(publishKontrol(dev.topik_kontrol, "OFF"));
                console.log(`➡️ Pause: published OFF for ${dev.nama_perangkat}`);
              } else {
                console.warn(`⚠️ Pause target ${dev.nama_perangkat} tidak punya topik_kontrol`);
              }
            } catch (e) {
              console.error(`❌ Gagal publish OFF untuk ${dev.nama_perangkat}:`, e.message || e);
              // lanjutkan proses (jangan rollback)
            }

            // update status & AktivasiManual (sebagai Pause)
            await dev.update({ status: "OFF" });

            const existingPause = await AktivasiManual.findOne({
              where: { perangkat_id: dev.id, jam_selesai: null },
              order: [["id", "DESC"]],
            });

            if (existingPause) {
              await existingPause.update({
                tanggal_selesai: selesai.format("YYYY-MM-DD"),
                jam_selesai: selesai.format("HH:mm:ss"),
                durasi_menit: Number(durasi || 0),
                tipe: "Pause",
              });
            } else {
              await AktivasiManual.create({
                perangkat_id: dev.id,
                tanggal_mulai: now.format("YYYY-MM-DD"),
                jam_mulai: now.format("HH:mm:ss"),
                tanggal_selesai: selesai.format("YYYY-MM-DD"),
                jam_selesai: selesai.format("HH:mm:ss"),
                durasi_menit: Number(durasi || 0),
                tipe: "Pause",
              });
            }
          }
        }
      }

      return res.json({
        success: true,
        newStatus: "ON",
        message:
          Number(durasi || 0) > 0
            ? `Perangkat dinyalakan (${durasi} menit).`
            : "Perangkat dinyalakan.",
      });
    }

    // ================= OFF =================
    if (state === "OFF") {
      console.log(`➡️ Request -> OFF : ${perangkat.nama_perangkat} (${perangkat.id})`);

      // publish OFF first (if topic exists). If publish gagal, respond error and do not change DB
      if (perangkat.topik_kontrol) {
        try {
          await Promise.resolve(publishKontrol(perangkat.topik_kontrol, "OFF"));
          console.log(`✅ publishKontrol OFF success -> ${perangkat.topik_kontrol}`);
        } catch (pubErr) {
          console.error(`❌ publishKontrol OFF failed for ${perangkat.nama_perangkat}:`, pubErr.message || pubErr);
          return res.status(500).json({
            success: false,
            message: "Gagal mengirim perintah OFF ke perangkat (MQTT). Cek log server.",
            error: pubErr.message || String(pubErr),
          });
        }
      } else {
        console.warn(`⚠️ Perangkat "${perangkat.nama_perangkat}" tidak punya topik_kontrol — update status hanya di DB`);
      }

      // update DB status and penjadwalan flags as before
      await perangkat.update({ status: "OFF" });

      if (perangkat.penjadwalan_aktif) {
        await Penjadwalan.update(
          { aktif: 0, status: "OFF" },
          { where: { perangkat_id: perangkat.id } }
        );
        await Perangkat.update(
          { penjadwalan_aktif: 0, status: "OFF" },
          { where: { id: perangkat.id } }
        );
      }

      const now = moment().tz(TZ);
      const lastAktivasi = await AktivasiManual.findOne({
        where: { perangkat_id: perangkat.id },
        order: [["created_at", "DESC"]],
      });

      if (lastAktivasi && !lastAktivasi.jam_selesai) {
        const jamMulai = moment.tz(
          `${lastAktivasi.tanggal_mulai} ${lastAktivasi.jam_mulai}`,
          "YYYY-MM-DD HH:mm:ss",
          TZ
        );
        const durasiFinal = now.diff(jamMulai, "minutes");
        await lastAktivasi.update({
          tanggal_selesai: now.format("YYYY-MM-DD"),
          jam_selesai: now.format("HH:mm:ss"),
          durasi_menit: durasiFinal,
        });
      }

      return res.json({
        success: true,
        newStatus: "OFF",
        message: "Perangkat dimatikan.",
      });
    }
  } catch (error) {
    console.error("❌ Gagal mengubah status:", error);
    return res
      .status(500)
      .json({ success: false, message: error.message });
  }
};
