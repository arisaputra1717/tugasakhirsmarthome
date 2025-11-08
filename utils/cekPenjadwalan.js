const { Op } = require('sequelize');
const { Penjadwalan } = require('../models'); // pastikan sudah import

async function cekPenjadwalanAktif(perangkat_id, tanggal, jamMenit) {
  const [jamStr] = jamMenit.split(':');
  const slotMulai = `${jamStr.padStart(2, "0")}:00:00`;
  const slotSelesai = `${jamStr.padStart(2, "0")}:59:59`;

  const penjadwalanAktif = await Penjadwalan.findOne({
    where: {
      perangkat_id,
      aktif: true,
      tanggal_mulai: { [Op.lte]: tanggal },
      tanggal_selesai: { [Op.gte]: tanggal },
      jam_mulai: { [Op.lte]: slotSelesai },
      jam_selesai: { [Op.gte]: slotMulai },
    }
  });

  return penjadwalanAktif !== null;
}

// **EXPORT HARUS DI LUAR FUNGSI**
module.exports = {
  cekPenjadwalanAktif,
};
