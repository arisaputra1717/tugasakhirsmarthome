const { Perangkat, LimitEnergi, KapasitasDaya } = require("../models");
const Sequelize = require("sequelize");
const { Op } = Sequelize;

exports.hitungWFS = async (tanggal) => {
  try {
    // 1. Ambil kapasitas daya sistem
    const kapasitas = await KapasitasDaya.findOne({ order: [["id", "DESC"]] });
    const kapasitasMaks = kapasitas ? kapasitas.kapasitas_daya : 0;

    // 2. Ambil limit energi harian
    const limit = await LimitEnergi.findOne({
      where: {
        tanggal_mulai: { [Op.lte]: tanggal },
        tanggal_selesai: { [Op.gte]: tanggal },
      },
    });
    const limitHar = limit ? limit.batas_kwh * 1000 : null; // kWh -> Wh

    // 3. Ambil semua perangkat aktif
    const perangkatList = await Perangkat.findAll({
      where: { status: "ON", penjadwalan_aktif: true },
      order: [["tipe", "DESC"]], // NI dulu, I nanti
    });

    let totalDayaAktif = perangkatList.reduce((sum, p) => sum + p.daya_watt, 0);

    // 4. Jika melebihi kapasitas daya, beri warning
    if (totalDayaAktif > kapasitasMaks) {
      console.warn("Beban puncak melebihi kapasitas daya!");
      totalDayaAktif = kapasitasMaks; // batasi
    }

    // 5. Hitung total daya NI
    const niDevices = perangkatList.filter((p) => p.tipe === "Non Interrupt (NI)");
    const iDevices = perangkatList.filter((p) => p.tipe === "Interrupt (I)");

    let totalDayaNI = niDevices.reduce((sum, p) => sum + p.daya_watt, 0);

    // 6. Alokasikan energi untuk NI
    let sisaEnergi = limitHar ? limitHar - totalDayaNI : null;

    // 7. Hitung skor total untuk I
    const totalSkorI = iDevices.reduce((sum, p) => sum + parseFloat(p.skor_prioritas), 0);

    // 8. Hitung kuota durasi penyalaan
    for (const p of perangkatList) {
      let kuota = 0;
      if (p.tipe === "Non Interrupt (NI)") {
        // energi penuh
        kuota = p.durasi_jam;
      } else if (p.tipe === "Interrupt (I)" && limitHar) {
        // WFS: alokasi sisa energi berdasarkan skor prioritas
        kuota = (parseFloat(p.skor_prioritas) / totalSkorI) * sisaEnergi / p.daya_watt;
      }
      // update di DB
      await p.update({ kuota_durasi_penyalaan: kuota });
    }

    console.log("Perhitungan WFS selesai untuk tanggal:", tanggal);
    return true;
  } catch (err) {
    console.error("Error hitung WFS:", err);
    return false;
  }
};
