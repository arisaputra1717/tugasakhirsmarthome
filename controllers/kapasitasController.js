const { KapasitasDaya } = require('../models');

// Tampilkan form + data
exports.index = async (req, res) => {
  try {
    const data = await KapasitasDaya.findAll({
      order: [['created_at', 'DESC']],
      limit: 20
    });

    res.render('kapasitas/index', { data });
  } catch (error) {
    console.error(error);
    res.status(500).send('Gagal memuat kapasitas daya');
  }
};

// Simpan atau update kapasitas daya (hanya 1 data yang disimpan)
exports.store = async (req, res) => {
  try {
    let { kapasitas_daya } = req.body;

    if (!kapasitas_daya) {
      return res.status(400).send('Kapasitas daya wajib diisi');
    }

    // Pastikan jadi angka lalu kalikan 0.8
    kapasitas_daya = parseFloat(kapasitas_daya) * 0.8;

    // Cari apakah sudah ada data
    const existing = await KapasitasDaya.findOne();

    if (existing) {
      // Update data yang sudah ada
      await existing.update({ kapasitas_daya });
    } else {
      // Buat data baru jika kosong
      await KapasitasDaya.create({ kapasitas_daya });
    }

    res.json({
      status: "success",
      message: "Data Kapasitas Berhasil Disimpan!",
    });
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ status: "error", message: "Gagal Menyimpan Kapasitas Daya" });
  }
};
