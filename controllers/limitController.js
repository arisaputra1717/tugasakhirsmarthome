// controllers/limitController.js – SIAP PAKAI
const { LimitEnergi, Penjadwalan, Perangkat } = require("../models");
const { Op } = require("sequelize");
const moment = require("moment-timezone");
const { hitungWFSHybrid } = require("../services/wfsServices");

const TZ = "Asia/Jakarta";

// GET semua limit (render halaman)
exports.index = async (req, res) => {
  try {
    const limitList = await LimitEnergi.findAll({ order: [["id", "DESC"]] });
    res.render("limit/index", { title: "Limit Energi", limitList });
  } catch (err) {
    res.status(500).send("Gagal mengambil data limit");
  }
};

// GET edit form
exports.edit = async (req, res) => {
  try {
    const limit = await LimitEnergi.findByPk(req.params.id);
    if (!limit) return res.status(404).send("Data tidak ditemukan");
    res.render("limit/edit", { limit });
  } catch (err) {
    res.status(500).send("Gagal mengambil data untuk diedit");
  }
};

// POST create limit
exports.store = async (req, res) => {
  try {
    let { batas_kwh, tanggal_mulai, tanggal_selesai } = req.body;

    batas_kwh = Number(batas_kwh);
    if (!batas_kwh || !tanggal_mulai || !tanggal_selesai) {
      return res.status(400).json({ status: "error", message: "Input tidak lengkap" });
    }

    // normalisasi tanggal ke YYYY-MM-DD
    tanggal_mulai = new Date(tanggal_mulai).toISOString().slice(0, 10);
    tanggal_selesai = new Date(tanggal_selesai).toISOString().slice(0, 10);

    // cek overlap
    const existing = await LimitEnergi.findOne({
      where: {
        [Op.and]: [
          { tanggal_mulai: { [Op.lte]: tanggal_selesai } },
          { tanggal_selesai: { [Op.gte]: tanggal_mulai } },
        ],
      },
    });
    if (existing) {
      return res.status(400).json({ status: "error", message: "Rentang tanggal bentrok dengan data yang ada" });
    }

    // simpan
    const data = await LimitEnergi.create({ batas_kwh, tanggal_mulai, tanggal_selesai });

    // reset durasi & hitung kuota
    await Perangkat.update({ durasi_terpakai: 0 }, { where: {} });
    await hitungWFSHybrid(moment().tz(TZ).toDate());

    // emit ke dashboard (opsional)
    try {
      if (global.io) {
        global.io.emit("limit-updated", {
          totalEnergi: 0,
          limit: { batas_kwh, tanggal_mulai, tanggal_selesai },
          persenLimit: 0,
        });
      }
    } catch (_) {}

    return res.json({ status: "success", message: "Data berhasil disimpan", data });
  } catch (err) {
    console.error("limit.store:", err);
    return res.status(500).json({ status: "error", message: "Gagal menyimpan data" });
  }
};

// POST update limit
exports.update = async (req, res) => {
  try {
    const { id } = req.params;
    let { batas_kwh, tanggal_mulai, tanggal_selesai } = req.body;

    const limit = await LimitEnergi.findByPk(id);
    if (!limit) return res.status(404).json({ status: "error", message: "Data tidak ditemukan" });

    if (batas_kwh != null) batas_kwh = Number(batas_kwh);
    tanggal_mulai = tanggal_mulai ? new Date(tanggal_mulai).toISOString().slice(0, 10) : limit.tanggal_mulai;
    tanggal_selesai = tanggal_selesai ? new Date(tanggal_selesai).toISOString().slice(0, 10) : limit.tanggal_selesai;

    // cek overlap kecuali dirinya
    const existing = await LimitEnergi.findOne({
      where: {
        id: { [Op.ne]: id },
        [Op.and]: [
          { tanggal_mulai: { [Op.lte]: tanggal_selesai } },
          { tanggal_selesai: { [Op.gte]: tanggal_mulai } },
        ],
      },
    });
    if (existing) {
      return res.status(400).json({ status: "error", message: "Rentang tanggal bentrok dengan data yang ada" });
    }

    await limit.update({
      batas_kwh: batas_kwh ?? limit.batas_kwh,
      tanggal_mulai,
      tanggal_selesai,
    });

    // reset durasi & hitung kuota baru
    await Perangkat.update({ durasi_terpakai: 0 }, { where: {} });
    await hitungWFSHybrid(moment().tz(TZ).toDate());

    try {
      if (global.io) {
        global.io.emit("limit-updated", {
          totalEnergi: 0,
          limit: {
            batas_kwh: Number(limit.batas_kwh),
            tanggal_mulai: limit.tanggal_mulai,
            tanggal_selesai: limit.tanggal_selesai,
          },
          persenLimit: 0,
        });
      }
    } catch (_) {}

    return res.json({ status: "success", message: "Data berhasil diupdate" });
  } catch (err) {
    console.error("limit.update:", err);
    return res.status(500).json({ status: "error", message: "Gagal mengupdate data" });
  }
};

// POST delete limit
// controllers/limitController.js – hanya fungsi destroy
exports.destroy = async (req, res) => {
  try {
    const { id } = req.params;

    const limit = await LimitEnergi.findByPk(id);
    if (!limit) {
      return res.status(404).json({ status: "error", message: "Limit energi tidak ditemukan" });
    }

    // (opsional) hapus jadwal yang overlap rentang limit
    await Penjadwalan.destroy({
      where: {
        [Op.or]: [
          { tanggal_mulai: { [Op.between]: [limit.tanggal_mulai, limit.tanggal_selesai] } },
          { tanggal_selesai: { [Op.between]: [limit.tanggal_mulai, limit.tanggal_selesai] } },
          {
            [Op.and]: [
              { tanggal_mulai: { [Op.lte]: limit.tanggal_mulai } },
              { tanggal_selesai: { [Op.gte]: limit.tanggal_selesai } },
            ],
          },
        ],
      },
    });

    // Hapus limit
    await LimitEnergi.destroy({ where: { id } });

    // ⛳ Perbaikan utama: JANGAN set null, set 0 agar tidak kena notNull
    await Perangkat.update(
      { kuota_durasi: 0, durasi_terpakai: 0 },
      { where: {} }
    );

    // Emit ke dashboard (boleh dipertahankan)
    try {
      if (global.io) {
        global.io.emit("limit-updated", { totalEnergi: 0, limit: null, persenLimit: 0 });
      }
    } catch (_) {}

    return res.json({ status: "success", message: "Data limit dan penjadwalan terkait berhasil dihapus" });
  } catch (err) {
    console.error("limit.destroy:", err);
    return res.status(500).json({ status: "error", message: "Gagal menghapus" });
  }
};
