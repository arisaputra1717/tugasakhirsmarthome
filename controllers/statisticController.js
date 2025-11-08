const { DataPenggunaan, Perangkat, LimitEnergi } = require('../models');
const { Op } = require('sequelize');

exports.index = async (req, res) => {
  try {
    const perangkat = await Perangkat.findAll();
    res.render('statistic/index', { title: 'Statistik Energi', perangkat });
  } catch (err) {
    res.status(500).send('Gagal load halaman statistik');
  }
};

exports.getChartData = async (req, res) => {
  try {
    const { tanggal } = req.query;
    if (!tanggal) {
      return res.status(400).json({ 
        status: "error", 
        message: "Tanggal wajib diisi" 
      });
    }

    // Validasi format tanggal
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(tanggal)) {
      return res.status(400).json({ 
        status: "error", 
        message: "Format tanggal tidak valid (YYYY-MM-DD)" 
      });
    }

    // Konversi tanggal dari string jadi Date (awal dan akhir hari)
    const startDate = new Date(tanggal);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(tanggal);
    endDate.setHours(23, 59, 59, 999);

    // Validasi tanggal valid
    if (isNaN(startDate.getTime())) {
      return res.status(400).json({ 
        status: "error", 
        message: "Tanggal tidak valid" 
      });
    }

    // Ambil limit aktif di tanggal tersebut
    const limit = await LimitEnergi.findOne({
      where: {
        tanggal_mulai: { [Op.lte]: endDate },
        tanggal_selesai: { [Op.gte]: startDate }
      },
      order: [['tanggal_mulai', 'DESC']]
    });

    // Ambil data energi per jam pada tanggal tersebut
    const data = await DataPenggunaan.findAll({
      attributes: ['timestamp', 'energy_delta'],
      where: {
        timestamp: {
          [Op.between]: [startDate, endDate]
        },
        // Filter data yang valid (tidak null dan >= 0)
        energy_delta: {
          [Op.not]: null,
          [Op.gte]: 0
        }
      },
      order: [['timestamp', 'ASC']]
    });

    // Group by jam dengan penanganan yang lebih robust
    const grouped = {};
    let totalRecords = 0;
    
    for (let row of data) {
      // Pastikan energy_delta adalah number yang valid
      const energyValue = parseFloat(row.energy_delta);
      if (isNaN(energyValue) || energyValue < 0) {
        console.warn(`Invalid energy_delta value: ${row.energy_delta} at ${row.timestamp}`);
        continue;
      }

      const hour = new Date(row.timestamp).getHours();
      grouped[hour] = (grouped[hour] || 0) + energyValue;
      totalRecords++;
    }

    // Generate labels dan values untuk 24 jam
    const labels = [];
    const values = [];
    
    for (let h = 0; h < 24; h++) {
      labels.push(`${h.toString().padStart(2, '0')}:00`);
      values.push(parseFloat((grouped[h] || 0).toFixed(3))); // 3 decimal untuk precision
    }

    // Hitung total energi
    const total = values.reduce((sum, val) => sum + val, 0);
    const limitKwh = limit?.batas_kwh || 0;
    const percent = limitKwh > 0 ? (total / limitKwh) * 100 : 0;

    // Status dengan logic yang lebih detail
    let status;
    if (limitKwh === 0) {
      status = '❓ Tidak ada limit';
    } else if (percent >= 100) {
      status = '🔴 Melebihi limit';
    } else if (percent >= 90) {
      status = '🟠 Hampir melebihi limit';
    } else if (percent >= 80) {
      status = '🟡 Mendekati limit';
    } else if (percent >= 50) {
      status = '🟢 Normal';
    } else {
      status = '🔵 Hemat';
    }

    // Response dengan informasi tambahan untuk debugging
    const response = {
      status: "success",
      chartLabels: labels,
      chartData: values,
      totalEnergi: total.toFixed(2) + ' kWh',
      limitKwh: limitKwh.toString() + ' kWh',
      persentase: parseFloat(percent.toFixed(1)),
      statusKwh: status,
    };

    res.json(response);

  } catch (err) {
    console.error('Error in getChartData:', err);
    res.status(500).json({ 
      status: "error", 
      message: "Gagal mengambil data statistik",
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};
