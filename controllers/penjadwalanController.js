// controllers/penjadwalanController.js — VALIDASI LIMIT: MENJUMlAH JADWAL YANG MENUTUPI SETIAP TANGGAL (TERMASUK SPAN >1 HARI)
const {
  Penjadwalan,
  Perangkat,
  LimitEnergi,
  AktivasiManual,
  DataPenggunaan, // biarkan saja kalau dipakai tempat lain
} = require("../models");
const { Op } = require("sequelize");
const moment = require("moment-timezone");
const { jalankanPenjadwalan } = require("../services/schedulerService");
const { simulateAndRecommendDynamic } = require("../services/recommender");

const TZ = "Asia/Jakarta";

// ===== Helpers umum =====
function hhmmToHours(hhmm) {
  const [h, m] = String(hhmm || "00:00").split(":").map(Number);
  if (!isFinite(h) || !isFinite(m)) return 0;
  return h + m / 60;
}

// Hitung durasi jam (desimal) yang jatuh di tanggal 'tgl' (YYYY-MM-DD) untuk sebuah jadwal dengan tanggal_mulai, tanggal_selesai, jam_mulai, jam_selesai
function sliceHoursForDate(tgl, tanggal_mulai, tanggal_selesai, jam_mulai, jam_selesai) {
  const sameDay = tanggal_mulai === tanggal_selesai;

  if (sameDay && tgl === tanggal_mulai) {
    // satu hari saja
    const dur = Math.max(0, hhmmToHours(jam_selesai) - hhmmToHours(jam_mulai));
    return dur;
  }

  // rentang > 1 hari
  if (tgl === tanggal_mulai) {
    // dari jam_mulai sampai 23:59
    const end = 24.0; // treat 23:59 ~ 24.00 secara praktis
    const dur = Math.max(0, end - hhmmToHours(jam_mulai));
    return dur;
  }
  if (tgl === tanggal_selesai) {
    // dari 00:00 sampai jam_selesai
    const dur = Math.max(0, hhmmToHours(jam_selesai) - 0);
    return dur;
  }

  // jika tgl di antara (tanggal_mulai, tanggal_selesai)
  const isMiddle =
    new Date(tgl) > new Date(tanggal_mulai) && new Date(tgl) < new Date(tanggal_selesai);
  if (isMiddle) {
    return 24.0; // 00:00–24:00 penuh
  }

  return 0;
}

// Daftar semua tanggal (YYYY-MM-DD) di dalam rentang inclusive [d1..d2]
function enumerateDatesInclusive(d1, d2) {
  const a = [];
  let cur = moment.tz(d1, "YYYY-MM-DD", TZ).startOf("day");
  const end = moment.tz(d2, "YYYY-MM-DD", TZ).startOf("day");
  while (cur.isSameOrBefore(end, "day")) {
    a.push(cur.format("YYYY-MM-DD"));
    cur = cur.add(1, "day");
  }
  return a;
}

// Total energi kWh dari semua JADWAL EKSISTING yang MENUTUPI tanggal tgl (entah intrahari atau span beberapa hari)
// excludeScheduleId => saat edit, agar tidak menghitung dirinya sendiri
async function totalEnergiPlannedPadaTanggal(tgl, { excludeScheduleId = null } = {}) {
  const where = {
    [Op.and]: [
      { tanggal_mulai: { [Op.lte]: tgl } },
      { tanggal_selesai: { [Op.gte]: tgl } },
    ],
  };
  if (excludeScheduleId) where.id = { [Op.ne]: excludeScheduleId };

  const list = await Penjadwalan.findAll({
    where,
    include: [{ model: Perangkat, attributes: ["id", "daya_watt", "nama_perangkat"] }],
  });

  let total = 0;
  for (const s of list) {
    const dur = sliceHoursForDate(
      tgl,
      s.tanggal_mulai,
      s.tanggal_selesai,
      s.jam_mulai,
      s.jam_selesai
    );
    const dayaW = Number(s.Perangkat?.daya_watt || 0);
    total += (dayaW / 1000) * dur;
  }
  return total; // kWh
}

// ==========================
// LIST
// ==========================
exports.index = async (req, res) => {
  try {
    const penjadwalan = await Penjadwalan.findAll({
      include: [
        { model: Perangkat, attributes: ["id", "nama_perangkat", "topik_mqtt", "penjadwalan_aktif"] },
      ],
      order: [
        ["tanggal_mulai", "ASC"],
        ["jam_mulai", "ASC"],
      ],
    });

    const perangkat = await Perangkat.findAll({
      attributes: ["id", "nama_perangkat", "topik_mqtt", "penjadwalan_aktif"],
      order: [["nama_perangkat", "ASC"]],
    });

    res.render("penjadwalan/index", { title: "Penjadwalan", penjadwalan, perangkat });
  } catch (err) {
    console.error("❌ Gagal memuat penjadwalan:", err.message);
    res.status(500).send("Gagal memuat penjadwalan");
  }
};

// ==========================
// CREATE FORM
// ==========================
exports.createForm = async (req, res) => {
  try {
    const perangkatList = await Perangkat.findAll({
      attributes: [
        "id",
        "nama_perangkat",
        "topik_mqtt",
        "daya_watt",
        "durasi_jam",
        "tipe",
        "skor_prioritas",
        "penjadwalan_aktif",
      ],
      order: [["nama_perangkat", "ASC"]],
    });

    res.render("penjadwalan/create", { perangkatList });
  } catch (err) {
    console.error("❌ Gagal menampilkan form tambah jadwal:", err.message);
    res.status(500).send("Gagal menampilkan form tambah jadwal");
  }
};

// ==========================
// CREATE (STORE)
// ==========================
exports.store = async (req, res) => {
  try {
    const {
      perangkat_id,
      tanggal_range,
      jam_mulai,
      jam_selesai,
      fromRecommendation,
    } = req.body;

    const aktif = "1";

    if (!perangkat_id || !tanggal_range || !jam_mulai || !jam_selesai) {
      return res.status(400).json({ status: "error", message: "Semua field wajib diisi" });
    }

    const ids           = Array.isArray(perangkat_id) ? perangkat_id : [perangkat_id];
    const ranges        = Array.isArray(tanggal_range) ? tanggal_range : [tanggal_range];
    const jamMulaiArr   = Array.isArray(jam_mulai) ? jam_mulai : [jam_mulai];
    const jamSelesaiArr = Array.isArray(jam_selesai) ? jam_selesai : [jam_selesai];

    // ——— Rekomendasi beban puncak (tetap) ———
    const requestedForPeak = [];
    for (let i = 0; i < ids.length; i++) {
      const p = await Perangkat.findByPk(ids[i]);
      if (!p) {
        return res.status(400).json({ status: "error", message: `Perangkat dengan ID ${ids[i]} tidak ditemukan` });
      }
      requestedForPeak.push({
        id: p.id,
        nama_perangkat: p.nama_perangkat,
        daya_watt: p.daya_watt,
        tipe: p.tipe,
        skor_prioritas: p.skor_prioritas || 0,
        mulai: jamMulaiArr[i],
        selesai: jamSelesaiArr[i],
      });
    }
    if (!fromRecommendation) {
      const rec = await simulateAndRecommendDynamic(requestedForPeak);
      if (!rec.ok) {
        return res.status(409).json({
          status: "recommendation",
          message: "⚠️ Beban melebihi kapasitas pada interval tertentu. Sistem menyarankan perubahan jadwal.",
          rekomendasi: rec.localConflicts,
        });
      }
    }

    // ——— VALIDASI LIMIT ENERGI: per TANGGAL (termasuk range beberapa hari) ———
    // Kumpulkan energi request per tanggal (split per-hari)
    const reqKwhPerTanggal = {}; // { 'YYYY-MM-DD': kWh }
    for (let i = 0; i < ids.length; i++) {
      const pid = ids[i];
      const p = await Perangkat.findByPk(pid);
      if (!p) {
        return res.status(400).json({ status: "error", message: `Perangkat dengan ID ${pid} tidak ditemukan` });
      }

      const rangeStr = String(ranges[i] || "").trim();
      let tMulai, tSelesai;
      if (rangeStr.includes(" to ")) {
        const parts = rangeStr.split(" to ");
        tMulai = parts[0].trim();
        tSelesai = parts[1].trim();
      } else {
        tMulai = rangeStr;
        tSelesai = rangeStr;
      }

      const jmMulai = jamMulaiArr[i];
      const jmSelesai = jamSelesaiArr[i];

      // Iterasi setiap tanggal dalam rentang
      const days = enumerateDatesInclusive(tMulai, tSelesai);
      for (const tgl of days) {
        const dur = sliceHoursForDate(tgl, tMulai, tSelesai, jmMulai, jmSelesai); // jam
        if (dur <= 0) continue;
        const kwh = (Number(p.daya_watt || 0) / 1000) * dur;
        reqKwhPerTanggal[tgl] = (reqKwhPerTanggal[tgl] || 0) + kwh;
      }
    }

    // Untuk setiap tanggal yang disentuh request → cek limit & total rencana (existing + request)
    for (const tgl of Object.keys(reqKwhPerTanggal)) {
      const limit = await LimitEnergi.findOne({
        where: {
          tanggal_mulai: { [Op.lte]: tgl },
          tanggal_selesai: { [Op.gte]: tgl },
        },
        order: [["id", "DESC"]],
      });

      // Jika tidak ada limit untuk tanggal ini → tidak diblok (sesuai requirement “jika ADA limit, cek ketat”)
      if (!limit || Number(limit.batas_kwh) <= 0) continue;

      const batas = Number(limit.batas_kwh);
      const existingKwh = await totalEnergiPlannedPadaTanggal(tgl); // jadwal yang SUDAH ada yang menutupi tgl
      const requestKwh  = reqKwhPerTanggal[tgl];
      const totalPlan   = existingKwh + requestKwh;

      if (totalPlan > batas) {
        return res.status(400).json({
          status: "error",
          message: `Penjadwalan untuk tanggal ${tgl} melebihi limit energi (Existing ${existingKwh.toFixed(2)} kWh + Request ${requestKwh.toFixed(2)} kWh > Batas ${batas.toFixed(2)} kWh).`,
          detail: {
            tanggal: tgl,
            existing_jadwal_kwh: Number(existingKwh.toFixed(3)),
            request_jadwal_kwh: Number(requestKwh.toFixed(3)),
            total_rencana_kwh: Number(totalPlan.toFixed(3)),
            batas_kwh: batas,
          },
        });
      }
    }
    // ——— END VALIDASI LIMIT ———

    // ——— CREATE jadwal (sama seperti sebelumnya) ———
    const created = [];
    for (let i = 0; i < ids.length; i++) {
      const pid = ids[i];
      const rangeStr = String(ranges[i] || "").trim();
      const jmMulai = jamMulaiArr[i];
      const jmSelesai = jamSelesaiArr[i];

      let tanggal_mulai, tanggal_selesai;
      if (rangeStr.includes(" to ")) {
        const parts = rangeStr.split(" to ");
        tanggal_mulai = parts[0].trim();
        tanggal_selesai = parts[1].trim();
      } else {
        tanggal_mulai = rangeStr;
        tanggal_selesai = rangeStr;
      }

      const perangkat = await Perangkat.findByPk(pid);
      if (!perangkat) {
        return res.status(400).json({ status: "error", message: `Perangkat dengan ID ${pid} tidak ditemukan` });
      }

      if (new Date(tanggal_mulai) > new Date(tanggal_selesai)) {
        return res.status(400).json({ status: "error", message: "Tanggal mulai harus sama atau lebih awal dari tanggal selesai" });
      }
      if (jmMulai >= jmSelesai) {
        return res.status(400).json({ status: "error", message: "Jam mulai harus lebih awal dari jam selesai" });
      }

      const startDateTime = moment.tz(`${tanggal_mulai} ${jmMulai}`, TZ).toDate();
      const endDateTime   = moment.tz(`${tanggal_selesai} ${jmSelesai}`, TZ).toDate();

      // exact duplicate
      const exactSame = await Penjadwalan.findOne({
        where: {
          perangkat_id: pid,
          tanggal_mulai,
          tanggal_selesai,
          jam_mulai: jmMulai,
          jam_selesai: jmSelesai,
        },
      });
      if (exactSame) {
        return res.status(400).json({ status: "error", message: "Jadwal dengan waktu yang sama persis sudah ada" });
      }

      // overlap (rentang tanggal)
      const existingSchedules = await Penjadwalan.findAll({
        where: {
          perangkat_id: pid,
          tanggal_mulai: { [Op.lte]: tanggal_selesai },
          tanggal_selesai: { [Op.gte]: tanggal_mulai },
        },
      });
      const hasConflict = existingSchedules.some((s) => {
        const oldStart = moment.tz(`${s.tanggal_mulai} ${s.jam_mulai}`, TZ).toDate();
        const oldEnd   = moment.tz(`${s.tanggal_selesai} ${s.jam_selesai}`, TZ).toDate();
        return startDateTime < oldEnd && endDateTime > oldStart;
      });
      if (hasConflict) {
        return res.status(400).json({ status: "error", message: "Jadwal bentrok dengan jadwal lain untuk perangkat ini" });
      }

      // status awal
      const now = moment.tz(TZ).toDate();
      let status = "OFF";
      if (now >= startDateTime && now <= endDateTime) status = "ON";

      const newSchedule = await Penjadwalan.create({
        perangkat_id: pid,
        tanggal_mulai,
        tanggal_selesai,
        jam_mulai: jmMulai,
        jam_selesai: jmSelesai,
        aktif,
        status,
      });

      await Perangkat.update({ penjadwalan_aktif: aktif }, { where: { id: pid } });

      const mMulai   = moment.tz(`${tanggal_mulai} ${jmMulai}`, "YYYY-MM-DD HH:mm", TZ);
      const mSelesai = moment.tz(`${tanggal_selesai} ${jmSelesai}`, "YYYY-MM-DD HH:mm", TZ);

      await AktivasiManual.create({
        perangkat_id: pid,
        tanggal_mulai: mMulai.format("YYYY-MM-DD"),
        tanggal_selesai: mSelesai.format("YYYY-MM-DD"),
        jam_mulai: mMulai.format("HH:mm:ss"),
        jam_selesai: mSelesai.format("HH:mm:ss"),
        durasi_menit: mSelesai.diff(mMulai, "minutes"),
        tipe: "Penjadwalan",
      });

      created.push(newSchedule);
    }

    // Jalankan WFS untuk perangkat terkait
    const perangkatIds = created.map((s) => s.perangkat_id);
    await jalankanPenjadwalan(perangkatIds);

    return res.json({
      status: "success",
      message: `${created.length} penjadwalan berhasil dibuat`,
      data: { created },
    });
  } catch (err) {
    console.error("❌ Gagal membuat jadwal:", err.message);
    return res.status(500).json({ status: "error", message: "Gagal membuat jadwal: " + err.message });
  }
};

// ==========================
// EDIT FORM
// ==========================
exports.editForm = async (req, res) => {
  try {
    const jadwal = await Penjadwalan.findByPk(req.params.id, { include: [{ model: Perangkat }] });
    if (!jadwal) return res.status(404).send("Jadwal tidak ditemukan");

    const perangkatList = await Perangkat.findAll({
      attributes: ["id", "nama_perangkat"],
      order: [["nama_perangkat", "ASC"]],
    });

    res.render("penjadwalan/edit", { jadwal, perangkatList });
  } catch (err) {
    console.error("❌ Gagal menampilkan form edit:", err.message);
    res.status(500).send("Gagal menampilkan form edit jadwal");
  }
};

// ==========================
// EDIT (UPDATE)
// ==========================
exports.edit = async (req, res) => {
  try {
    const jadwal = await Penjadwalan.findByPk(req.params.id);
    if (!jadwal) {
      return res.status(404).json({ status: "error", message: "Jadwal tidak ditemukan" });
    }

    const { perangkat_id, tanggal_mulai, tanggal_selesai, jam_mulai, jam_selesai } = req.body;
    const aktif = req.body.aktif === "1";

    if (!perangkat_id || !tanggal_mulai || !tanggal_selesai || !jam_mulai || !jam_selesai) {
      return res.status(400).json({ status: "error", message: "Semua field wajib diisi" });
    }

    const perangkat = await Perangkat.findByPk(perangkat_id);
    if (!perangkat) {
      return res.status(400).json({ status: "error", message: "Perangkat tidak ditemukan" });
    }

    if (new Date(tanggal_mulai) > new Date(tanggal_selesai)) {
      return res.status(400).json({ status: "error", message: "Tanggal mulai harus <= tanggal selesai" });
    }
    if (jam_mulai >= jam_selesai) {
      return res.status(400).json({ status: "error", message: "Jam mulai harus lebih awal dari jam selesai" });
    }

    // VALIDASI LIMIT: iterasi setiap tanggal di range baru, hitung request slice + existing (kecualikan dirinya)
    const days = enumerateDatesInclusive(tanggal_mulai, tanggal_selesai);
    for (const tgl of days) {
      const durSlice = sliceHoursForDate(tgl, tanggal_mulai, tanggal_selesai, jam_mulai, jam_selesai);
      if (durSlice <= 0) continue;

      const requestKwh = (Number(perangkat.daya_watt || 0) / 1000) * durSlice;

      const limit = await LimitEnergi.findOne({
        where: {
          tanggal_mulai: { [Op.lte]: tgl },
          tanggal_selesai: { [Op.gte]: tgl },
        },
        order: [["id", "DESC"]],
      });

      if (limit && Number(limit.batas_kwh) > 0) {
        const existingKwh = await totalEnergiPlannedPadaTanggal(tgl, { excludeScheduleId: jadwal.id });
        const totalPlan = existingKwh + requestKwh;
        if (totalPlan > Number(limit.batas_kwh)) {
          return res.status(400).json({
            status: "error",
            message: `Update melebihi limit energi tanggal ${tgl} (Existing ${existingKwh.toFixed(2)} kWh + Request ${requestKwh.toFixed(2)} kWh > Batas ${Number(limit.batas_kwh).toFixed(2)} kWh).`,
          });
        }
      }
    }

    // Update jadwal
    await Penjadwalan.update(
      { perangkat_id, tanggal_mulai, tanggal_selesai, jam_mulai, jam_selesai, aktif },
      { where: { id: req.params.id } }
    );

    // Histori AktivasiManual
    const mMulai = moment.tz(`${tanggal_mulai} ${jam_mulai}`, "YYYY-MM-DD HH:mm", TZ);
    const mSelesai = moment.tz(`${tanggal_selesai} ${jam_selesai}`, "YYYY-MM-DD HH:mm", TZ);
    const durasiMenit = mSelesai.diff(mMulai, "minutes");

    const histori = await AktivasiManual.findOne({
      where: {
        perangkat_id: perangkat_id,
        tanggal_mulai: jadwal.tanggal_mulai,
        tanggal_selesai: jadwal.tanggal_selesai,
        jam_mulai: moment(jadwal.jam_mulai, "HH:mm").format("HH:mm:ss"),
        jam_selesai: moment(jadwal.jam_selesai, "HH:mm").format("HH:mm:ss"),
        tipe: "Penjadwalan",
      },
    });

    if (histori) {
      await AktivasiManual.update(
        {
          perangkat_id,
          tanggal_mulai: mMulai.format("YYYY-MM-DD"),
          tanggal_selesai: mSelesai.format("YYYY-MM-DD"),
          jam_mulai: mMulai.format("HH:mm:ss"),
          jam_selesai: mSelesai.format("HH:mm:ss"),
          durasi_menit: durasiMenit,
        },
        { where: { id: histori.id } }
      );
    } else {
      await AktivasiManual.create({
        perangkat_id,
        tanggal_mulai: mMulai.format("YYYY-MM-DD"),
        tanggal_selesai: mSelesai.format("YYYY-MM-DD"),
        jam_mulai: mMulai.format("HH:mm:ss"),
        jam_selesai: mSelesai.format("HH:mm:ss"),
        durasi_menit: durasiMenit,
        tipe: "Penjadwalan",
      });
    }

    await jalankanPenjadwalan([perangkat_id]);

    return res.json({ status: "success", message: "Penjadwalan berhasil diupdate" });
  } catch (err) {
    console.error("❌ Gagal mengupdate jadwal:", err.message);
    return res.status(500).json({ status: "error", message: "Gagal mengupdate jadwal: " + err.message });
  }
};

// ==========================
// DELETE
// ==========================
exports.delete = async (req, res) => {
  try {
    const jadwal = await Penjadwalan.findByPk(req.params.id);
    if (!jadwal) {
      return res.status(404).json({ status: "error", message: "Jadwal tidak ditemukan" });
    }

    await jadwal.destroy();

    res.json({ status: "success", message: "Data penjadwalan berhasil dihapus" });
  } catch (err) {
    console.error("❌ Gagal menghapus jadwal:", err.message);
    res.status(500).json({ status: "error", message: "Gagal menghapus jadwal" });
  }
};

// ==========================
// TOGGLE
// ==========================
exports.toggle = async (req, res) => {
  try {
    const jadwal = await Penjadwalan.findByPk(req.params.id);
    if (!jadwal) return res.status(404).send("Jadwal tidak ditemukan");

    await jadwal.update({ aktif: !jadwal.aktif });

    res.redirect("/penjadwalan");
  } catch (err) {
    console.error("❌ Gagal toggle jadwal:", err.message);
    res.status(500).send("Gagal toggle jadwal");
  }
};
