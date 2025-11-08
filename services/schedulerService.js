// services/schedulerService.js
const { Perangkat, Penjadwalan, LimitEnergi, KapasitasDaya } = require("../models");
const Sequelize = require("sequelize");
const { Op } = Sequelize;
const moment = require("moment-timezone");

const TZ = "Asia/Jakarta";

/** Hitung selisih jam per hari dari HH:mm - HH:mm (toleransi lintas tengah malam) */
function diffJamPerHari(jamMulai, jamSelesai) {
  const m0 = moment.tz(jamMulai, "HH:mm", TZ);
  const m1 = moment.tz(jamSelesai, "HH:mm", TZ);
  let menit = m1.diff(m0, "minutes");
  if (menit <= 0) menit = 24 * 60 + menit; // lintas 00:00
  return menit / 60; // jam
}

/** Sisa target jam sebuah perangkat (target - durasi_terpakai, minimal 0) */
function sisaTargetJam(p) {
  const target = +p.durasi_jam || Infinity;
  const terpakai = +p.durasi_terpakai || 0;
  return Math.max(0, target - terpakai);
}

/** Fungsi utama scheduler */
async function jalankanPenjadwalan(perangkatIds = []) {
  try {
    const targetDateStr = moment().tz(TZ).format("YYYY-MM-DD");
    console.log(`\n======= 🧮 SCHEDULER : ${targetDateStr} =======`);

    // 1) Ambil limit aktif (overlap tanggal target)
    const limit = await LimitEnergi.findOne({
      where: {
        tanggal_mulai: { [Op.lte]: targetDateStr },
        tanggal_selesai: { [Op.gte]: targetDateStr },
      },
    });
    if (!limit) {
      console.log("ℹ  Tidak ada limit aktif untuk tanggal ini.");
      console.log("✅ Scheduler selesai.\n");
      return true;
    }
    const limitWh = (+limit.batas_kwh || 0) * 1000;

    // 2) Ambil semua perangkat
    const semuaPerangkat = await Perangkat.findAll({ order: [["id", "ASC"]] });
    // (opsional) filter untuk logging saja: perangkat yang baru dibuat di controller
    const perangkatFocusIdSet = new Set((perangkatIds || []).map(String));

    // 3) Ambil semua jadwal AKTIF yang overlap tanggal target
    const jadwalAktif = await Penjadwalan.findAll({
      where: {
        aktif: true,
        tanggal_mulai: { [Op.lte]: targetDateStr },
        tanggal_selesai: { [Op.gte]: targetDateStr },
      },
    });

    // 4) Hitung total jam terjadwal per perangkat (hari ini)
    const durasiTerjadwalJam = new Map(); // pid -> total jam
    for (const j of jadwalAktif) {
      const jam = diffJamPerHari(j.jam_mulai, j.jam_selesai);
      const prev = durasiTerjadwalJam.get(j.perangkat_id) || 0;
      durasiTerjadwalJam.set(j.perangkat_id, prev + jam);
    }
    const scheduledToday = new Set([...durasiTerjadwalJam.keys()]);

    // 5) Klasifikasi tipe (fleksibel)
    const isNI = (t = "") => /non\s*interrupt/i.test(t || "");
    const isI = (t = "") => /(^|\s)interrupt/i.test(t || "") && !/non\s*interrupt/i.test(t || "");

    const niDevices = semuaPerangkat.filter((p) => isNI(p.tipe));
    const iDevices = semuaPerangkat.filter((p) => isI(p.tipe));

    // 6) Energi baseline
    // NI: jika ada jadwal → jam terjadwal; kalau tidak → durasi_jam (kuota penuh)
    const totalEnergiNI = niDevices.reduce((sum, p) => {
      const jamJadwal = durasiTerjadwalJam.get(p.id) || 0;
      const jamDipakai = jamJadwal > 0 ? jamJadwal : (+p.durasi_jam || 0);
      return sum + (+p.daya_watt || 0) * jamDipakai;
    }, 0);

    // I: hanya energi terjadwal yang masuk baseline
    const energiI_terjadwal = iDevices.reduce((sum, p) => {
      const jamJadwal = durasiTerjadwalJam.get(p.id) || 0;
      return sum + (+p.daya_watt || 0) * jamJadwal;
    }, 0);

    // 7) Sisa energi untuk dibagi ke I yang tidak berjadwal
    const sisaEnergiGlobal = Math.max(0, limitWh - totalEnergiNI - energiI_terjadwal);

    console.log(`📦 Total energi NI: ${totalEnergiNI} Wh`);
    console.log(`⚡ Energi terpakai I: ${energiI_terjadwal} Wh`);
    console.log(`🟩 Sisa energi global: ${sisaEnergiGlobal} Wh`);

    // 8) Update kuota NI (jadwal → jam terjadwal, tidak jadwal → durasi_jam)
    for (const p of niDevices) {
      const jamJadwal = durasiTerjadwalJam.get(p.id) || 0;
      const kuota = jamJadwal > 0 ? jamJadwal : (+p.durasi_jam || 0);
      await p.update({ kuota_durasi: parseFloat((+kuota).toFixed(2)) });

      const tag = jamJadwal > 0 ? "Kuota terjadwal" : "Kuota penuh";
      console.log(`🟢 ${p.nama_perangkat} (NI) -> ${tag}: ${kuota} jam`);
    }

    // 9) I yang TIDAK dijadwalkan → kandidat WFS
    const iTidakDijadwalkan = iDevices.filter((p) => !scheduledToday.has(p.id));

    const totalSkorI = iDevices.reduce((s, p) => s + (+p.skor_prioritas || 0), 0);
    const kandidatValid = iTidakDijadwalkan.filter(
      (p) =>
        (+p.skor_prioritas || 0) > 0 &&
        (+p.daya_watt || 0) > 0 &&
        sisaTargetJam(p) > 0
    );
    const totalSkorBelum = kandidatValid.reduce((s, p) => s + (+p.skor_prioritas || 0), 0);

    console.log(`➡ Total Skor Prioritas I: ${totalSkorI.toFixed(2)}`);
    console.log(`➡ Total Skor Prioritas yang belum dijadwalkan: ${totalSkorBelum.toFixed(2)}`);

    // 10) Bagi sisa energi proporsional untuk I tidak dijadwalkan
    for (const p of iTidakDijadwalkan) {
      const skor = +p.skor_prioritas || 0;
      const daya = +p.daya_watt || 0;
      const terpakai = +p.durasi_terpakai || 0;
      const sisa = sisaTargetJam(p);

      let kuotaBaru = terpakai;

      const valid =
        sisaEnergiGlobal > 0 && totalSkorBelum > 0 && skor > 0 && daya > 0 && sisa > 0;

      if (valid) {
        const alokasiWh = (skor / totalSkorBelum) * sisaEnergiGlobal;
        const tambahanJam = Math.min(alokasiWh / daya, sisa);
        kuotaBaru = parseFloat((terpakai + tambahanJam).toFixed(2));

        console.log(`   🟡 ${p.nama_perangkat} (skor ${skor.toFixed(4)})`);
        console.log(`      • Tambahan alokasi: ${alokasiWh.toFixed(2)} Wh`);
        console.log(`      • Kuota: ${kuotaBaru} jam`);
      } else {
        const alasan = [];
        if (!(sisaEnergiGlobal > 0)) alasan.push("sisaEnergi=0");
        if (!(totalSkorBelum > 0)) alasan.push("totalSkor=0");
        if (!(skor > 0)) alasan.push("skor=0");
        if (!(daya > 0)) alasan.push("daya=0");
        if (!(sisa > 0)) alasan.push("sisaTarget=0");

        console.log(`   🟡 ${p.nama_perangkat} (skor ${skor.toFixed(4)})`);
        console.log(
          `      • Tambahan alokasi: 0 Wh${alasan.length ? ` (alasan: ${alasan.join(", ")})` : ""}`
        );
        console.log(`      • Kuota: ${kuotaBaru} jam`);
      }

      await p.update({ kuota_durasi: kuotaBaru });
    }

    // 11) Pastikan I yang BERJADWAL minimal kuotanya = jam terjadwal
    for (const p of iDevices) {
      const jamJadwal = durasiTerjadwalJam.get(p.id) || 0;
      if (jamJadwal > 0) {
        const current = +p.kuota_durasi || 0;
        const ensured = Math.max(current, jamJadwal);
        if (ensured !== current) {
          await p.update({ kuota_durasi: parseFloat(ensured.toFixed(2)) });
        }
      }
    }

    // 12) Info beban puncak (informasi)
    const kapasitas = await KapasitasDaya.findOne({ order: [["id", "DESC"]] });
    const kapasitasMaks = kapasitas ? +kapasitas.kapasitas_daya : 0;
    console.log(`⚡ Kapasitas daya sistem: ${kapasitasMaks} Watt`);

    // estimasi daya ON informatif: perangkat yang punya jadwal hari ini
    const totalDayaON = semuaPerangkat.reduce((s, p) => {
      const onToday = durasiTerjadwalJam.get(p.id) || 0;
      return s + (onToday > 0 ? (+p.daya_watt || 0) : 0);
    }, 0);
    console.log(`🔌 Total daya perangkat ON: ${totalDayaON} Watt`);
    if (kapasitasMaks && totalDayaON > kapasitasMaks) {
      console.log(`⚠  Melebihi beban puncak! (${totalDayaON}W > ${kapasitasMaks}W)`);
    } else {
      console.log("✅ Belum mencapai beban puncak");
    }

    console.log("✅ Hybrid WFS selesai.\n");
    return true;
  } catch (err) {
    console.error("❌ Error Scheduler:", err);
    return false;
  }
}

module.exports = { jalankanPenjadwalan };