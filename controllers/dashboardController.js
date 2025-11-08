// controllers/dashboardController.js
const {
  Perangkat,
  DataPenggunaan,
  LimitEnergi,
  Penjadwalan,
  AktivasiManual,
} = require("../models");
const models = require("../models");
const { Op } = require("sequelize");

// === Helper waktu ===
function getCurrentTimeHHMM() {
  const now = new Date();
  return now.toTimeString().slice(0, 5); // "HH:mm"
}
function isTimeBetween(current, start, end) {
  return current >= start && current <= end;
}

// === Helper ambil kapasitas terpasang (Watt) dari DB dengan beberapa kemungkinan sumber ===
async function getKapasitasTerpasangW() {
  try {
    // 1) Model Setting { key, value }
    const Setting = models.Setting;
    if (Setting && typeof Setting.findOne === "function") {
      const candKeys = ["kapasitas_daya", "kapasitas_watt", "kapasitas_va_watt", "kapasitas"];
      for (const k of candKeys) {
        const row = await Setting.findOne({ where: { key: k } });
        if (row && row.value != null) {
          const n = Number(row.value);
          if (Number.isFinite(n) && n > 0) return n; // diasumsikan Watt
        }
      }
    }

    // 2) Model khusus kapasitas (ambil record terakhir)
    const KapasitasDaya = models.KapasitasDaya || models.Kapasitas || null;
    if (KapasitasDaya && typeof KapasitasDaya.findOne === "function") {
      const last = await KapasitasDaya.findOne({ order: [["id", "DESC"]] });
      if (last) {
        const candidates = ["watt", "kapasitas_watt", "kapasitas_daya", "nilai_watt"];
        for (const c of candidates) {
          if (c in last && last[c] != null) {
            const n = Number(last[c]);
            if (Number.isFinite(n) && n > 0) return n;
          }
        }
      }
    }
  } catch (_) {}

  // 3) fallback
  return 0;
}

exports.index = async (req, res) => {
  try {
    const now = new Date();
    const currentTime = getCurrentTimeHHMM();
    const todayStr = now.toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" });

    // === Sinkronisasi status perangkat berdasar penjadwalan (tanpa mengubah fungsi lain) ===
    const semuaJadwal = await Penjadwalan.findAll({
      where: {
        aktif: true,
        tanggal_mulai: { [Op.lte]: todayStr },
        tanggal_selesai: { [Op.gte]: todayStr },
      },
      include: [Perangkat],
    });

    for (const jadwal of semuaJadwal) {
      if (!jadwal.Perangkat) continue;

      const aktivasiManualAktif = await AktivasiManual.findOne({
        where: {
          perangkat_id: jadwal.Perangkat.id,
          tanggal_selesai: null,
          jam_selesai: null,
        },
      });
      if (aktivasiManualAktif) continue;

      const dalamWaktu = isTimeBetween(currentTime, jadwal.jam_mulai, jadwal.jam_selesai);
      if (dalamWaktu && jadwal.Perangkat.status !== "ON") {
        await jadwal.Perangkat.update({ status: "ON" });
      } else if (!dalamWaktu && jadwal.Perangkat.status !== "OFF") {
        await jadwal.Perangkat.update({ status: "OFF" });
      }
    }

    // === Perangkat + data meter terbaru ===
    const perangkatDanData = await Perangkat.findAll({
      include: [
        {
          model: DataPenggunaan,
          attributes: ["volt", "ampere", "watt", "energy", "timestamp"],
          limit: 1,
          order: [["timestamp", "DESC"]],
          required: false,
        },
      ],
      order: [["nama_perangkat", "ASC"]],
    });

    // === Total energi hari ini ===
    const startOfToday = new Date(todayStr);
    const totalEnergiHariIni =
      (await DataPenggunaan.sum("energy_delta", {
        where: { timestamp: { [Op.gte]: startOfToday } },
      })) || 0;

    // === Limit aktif ===
    const limitAktif = await LimitEnergi.findOne({
      where: {
        tanggal_mulai: { [Op.lte]: todayStr },
        tanggal_selesai: { [Op.gte]: todayStr },
      },
    });

    // === Persentase pemakaian vs limit ===
    let persentasePemakaian = null;
    if (limitAktif && limitAktif.batas_kwh > 0) {
      persentasePemakaian = Math.min(100, (totalEnergiHariIni / limitAktif.batas_kwh) * 100);
    }

    function isPerangkatDiblokirLimit(prioritas, persentase) {
      if (!persentase && persentase !== 0) return false;
      if (persentase >= 100) return ["Tinggi", "Sedang", "Rendah"].includes(prioritas);
      if (persentase >= 80) return ["Sedang", "Rendah"].includes(prioritas);
      if (persentase >= 60) return prioritas === "Rendah";
      return false;
    }

    // === Siapkan data kartu ===
    const dataTerbaru = await Promise.all(
      perangkatDanData.map(async (p) => {
        const adaPenjadwalan = await Penjadwalan.findOne({
          where: { perangkat_id: p.id, aktif: true },
        });

        const diblokirLimit = isPerangkatDiblokirLimit(p.prioritas, persentasePemakaian);

        return {
          perangkat: {
            id: p.id,
            nama_perangkat: p.nama_perangkat,
            status: p.status || "OFF",
            prioritas: p.prioritas,
            penjadwalan_aktif: !!adaPenjadwalan,
            daya_watt: p.daya_watt,
            diblokir_limit: diblokirLimit,
            skor_prioritas: p.skor_prioritas,
            // untuk UI kuota
            kuota_durasi: Number(p.kuota_durasi || 0),
            durasi_terpakai: Number(p.durasi_terpakai || 0),
          },
          data: p.DataPenggunaans[0] || null,
        };
      })
    );

    // === Data grafik ===
    const chartData = await Promise.all(
      perangkatDanData.map(async (p) => {
        const recentData = await DataPenggunaan.findAll({
          where: { perangkat_id: p.id },
          attributes: ["energy", "timestamp"],
          order: [["timestamp", "DESC"]],
          limit: 20,
        });
        return {
          perangkat_id: p.id,
          nama_perangkat: p.nama_perangkat,
          labels: recentData.map((d) => new Date(d.timestamp).toLocaleTimeString()).reverse(),
          data: recentData.map((d) => d.energy).reverse(),
        };
      })
    );

    // === Ambil kapasitas terpasang (Watt) dari DB dan kirim ke View ===
    const kapasitasTerpasangW = await getKapasitasTerpasangW();

    res.render("dashboard/index", {
      title: "Dashboard",
      dataTerbaru,
      totalEnergiHariIni,
      limit: limitAktif,
      persenLimit: persentasePemakaian ? persentasePemakaian.toFixed(1) : null,
      chartData: JSON.stringify(chartData),
      kapasitasTerpasangW, // ⬅️ untuk ditampilkan sebagai "… VA" di UI
    });
  } catch (err) {
    console.error("❌ Error in dashboardController:", err.stack);
    res.status(500).render("error", {
      title: "Smart Energy",
      error: "Gagal memuat dashboard: " + err.message,
    });
  }
};
