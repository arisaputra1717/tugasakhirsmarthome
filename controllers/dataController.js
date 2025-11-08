const { DataPenggunaan, Perangkat } = require('../models');

exports.index = async (req, res) => {
  try {
    const data = await DataPenggunaan.findAll({
      include: [{ model: Perangkat }],
      order: [['timestamp', 'DESC']],
      limit: 100
    });

    res.render('data/index', { data });
  } catch (error) {
    console.error(error);
    res.status(500).send('Gagal memuat data penggunaan');
  }
};
