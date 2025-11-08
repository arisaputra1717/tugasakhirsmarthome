// services/recommenderDynamic.js
const moment = require("moment");
const { Perangkat, Penjadwalan, KapasitasDaya } = require("../models");
const { Op } = require("sequelize");

/**
 * Helper: cek apakah dua interval waktu overlap
 */
function isOverlap(startA, endA, startB, endB) {
  return (
    moment(startA, "HH:mm").isBefore(moment(endB, "HH:mm")) &&
    moment(endA, "HH:mm").isAfter(moment(startB, "HH:mm"))
  );
}

/**
 * Hitung total load (Watt) pada interval tertentu
 */
function calcLoadAt(schedules, start, end) {
  return schedules
    .filter((s) => isOverlap(s.mulai, s.selesai, start, end))
    .reduce((sum, s) => sum + (s.daya_watt || 0), 0);
}

/**
 * Simulasi jadwal secara dinamis
 * schedules: array { id, nama_perangkat, daya_watt, tipe, skor_prioritas, mulai, selesai }
 */
async function simulateLoadDynamic(schedules, stepMinutes = 5) {
  const kapasitas = await KapasitasDaya.findOne({ order: [["id", "DESC"]] });
  const kapasitasWatt = kapasitas ? kapasitas.kapasitas_daya : 1040;

  const konflik = [];

  // iterasi 24 jam dengan step tertentu
  const startDay = moment("00:00", "HH:mm");
  const endDay = moment("23:59", "HH:mm");

  for (
    let t = startDay.clone();
    t.isBefore(endDay);
    t.add(stepMinutes, "minutes")
  ) {
    const tNext = t.clone().add(stepMinutes, "minutes");
    const load = calcLoadAt(
      schedules,
      t.format("HH:mm"),
      tNext.format("HH:mm")
    );

    if (load > kapasitasWatt) {
      konflik.push({
        interval: { mulai: t.format("HH:mm"), selesai: tNext.format("HH:mm") },
        load,
        kapasitasWatt,
      });
    }
  }

  return { kapasitasWatt, konflik };
}

/**
 * Saran shifting dinamis (tanpa bucket)
 */
function suggestShiftsDynamic(schedules, kapasitasWatt) {
  const suggestions = [];

  // urutkan perangkat dengan tipe **strict "Interrupt"** dan prioritas rendah dulu
  const candidates = schedules
    .filter(
      (s) => s.tipe && s.tipe.toLowerCase().trim() === "interrupt" // strict match
    )
    .sort((a, b) => (a.skor_prioritas || 0) - (b.skor_prioritas || 0));

  for (const c of candidates) {
    // cek load saat interval perangkat ini
    const load = calcLoadAt(schedules, c.mulai, c.selesai);
    if (load <= kapasitasWatt) continue;

    // cari slot baru: maju 15 menit sekali sampai ketemu slot aman
    let newStart = moment(c.mulai, "HH:mm");
    const duration = moment(c.selesai, "HH:mm").diff(
      moment(c.mulai, "HH:mm"),
      "minutes"
    );

    let found = false;
    for (let step = 1; step <= 24 * 4; step++) {
      const tryStart = newStart.clone().add(step * 15, "minutes");
      const tryEnd = tryStart.clone().add(duration, "minutes");

      const loadTry = calcLoadAt(
        schedules.filter((s) => s.id !== c.id),
        tryStart.format("HH:mm"),
        tryEnd.format("HH:mm")
      );

      if (loadTry + c.daya_watt <= kapasitasWatt) {
        suggestions.push({
          perangkat_id: c.id,
          nama_perangkat: c.nama_perangkat,
          from: { mulai: c.mulai, selesai: c.selesai },
          to: {
            mulai: tryStart.format("HH:mm"),
            selesai: tryEnd.format("HH:mm"),
          },
          reason: `Shifting karena beban ${load}W > ${kapasitasWatt}W`,
        });

        // update jadwal in-memory
        c.mulai = tryStart.format("HH:mm");
        c.selesai = tryEnd.format("HH:mm");
        found = true;
        break;
      }
    }

    if (!found) {
      suggestions.push({
        perangkat_id: c.id,
        nama_perangkat: c.nama_perangkat,
        action: "delay",
        reason: "Tidak ditemukan slot aman pada hari ini",
      });
    }
  }

  return suggestions;
}

// Tambahkan helper untuk cari slot aman
function findAvailableSlot(
  schedules,
  kapasitasWatt,
  request,
  stepMinutes = 15
) {
  const duration = moment(request.selesai, "HH:mm").diff(
    moment(request.mulai, "HH:mm"),
    "minutes"
  );

  for (let step = 1; step <= (24 * 60) / stepMinutes; step++) {
    const tryStart = moment(request.mulai, "HH:mm").add(
      step * stepMinutes,
      "minutes"
    );
    const tryEnd = tryStart.clone().add(duration, "minutes");

    // Stop kalau sudah lewat tengah malam
    if (tryEnd.isAfter(moment("23:59", "HH:mm"))) break;

    const loadTry = calcLoadAt(
      schedules,
      tryStart.format("HH:mm"),
      tryEnd.format("HH:mm")
    );

    if (loadTry + request.daya_watt <= kapasitasWatt) {
      return {
        mulai: tryStart.format("HH:mm"),
        selesai: tryEnd.format("HH:mm"),
      };
    }
  }

  return null;
}

/**
 * API utama
 */

async function simulateAndRecommendDynamic(requestedSchedules) {
  console.log("🚀 [simulateAndRecommendDynamic] mulai...");
  const tanggal = moment().format("YYYY-MM-DD");

  // Ambil penjadwalan aktif hari ini
  const existing = await Penjadwalan.findAll({
    where: {
      tanggal_mulai: { [Op.lte]: tanggal },
      tanggal_selesai: { [Op.gte]: tanggal },
      aktif: true,
    },
    include: [{ model: Perangkat }],
  });

  console.log(`📅 Tanggal cek: ${tanggal}`);
  console.log(`📂 Found ${existing.length} penjadwalan aktif`);

  const schedules = [];

  for (const s of existing) {
    if (!s.Perangkat) continue;
    schedules.push({
      id: `exist-${s.id}`,
      nama_perangkat: s.Perangkat.nama_perangkat,
      daya_watt: s.Perangkat.daya_watt,
      tipe: s.Perangkat.tipe,
      skor_prioritas: s.Perangkat.skor_prioritas || 0,
      mulai: s.jam_mulai,
      selesai: s.jam_selesai,
    });
  }

  // 🔎 validasi setiap request baru terhadap jadwal existing
  const kapasitas = await KapasitasDaya.findOne({ order: [["id", "DESC"]] });
  const kapasitasWatt = kapasitas ? kapasitas.kapasitas_daya : 1040;
  const localConflicts = [];

  console.log(`⚡ Kapasitas daya sistem: ${kapasitasWatt} W`);
  console.log(`📝 Mengecek ${requestedSchedules.length} request baru...`);

  // Urutkan requestedSchedules: Interrupt dulu, lalu skor_prioritas terkecil
  requestedSchedules.sort((a, b) => {
    // Non-Interrupt dulu
    if (a.tipe !== "Interrupt" && b.tipe === "Interrupt") return -1;

    // Interrupt
    if (a.tipe === "Interrupt" && b.tipe !== "Interrupt") return 1;

    // Jika tipe sama, urutkan berdasarkan skor_prioritas terkecil
    return (b.skor_prioritas || 0) - (a.skor_prioritas || 0);
  });

  for (const r of requestedSchedules) {
    const load = calcLoadAt([...schedules, r], r.mulai, r.selesai);

    console.log(
      `➡️ Request ${r.nama_perangkat} [${r.mulai}-${r.selesai}] membutuhkan ${r.daya_watt}W | Total load ${load}W`
    );

    if (load > kapasitasWatt) {
      console.log(
        `❌ Konflik! Load ${load}W > kapasitas ${kapasitasWatt}W untuk ${r.nama_perangkat}`
      );

      const altSlot = findAvailableSlot(schedules, kapasitasWatt, r);

      localConflicts.push({
        perangkat_id: r.id,
        nama_perangkat: r.nama_perangkat,
        interval: { mulai: r.mulai, selesai: r.selesai },
        load,
        kapasitasWatt,
        recommendation: altSlot
          ? { to: altSlot, reason: "Rekomendasi waktu kosong terdekat" }
          : {
              action: "delay",
              reason: "Tidak ada slot aman ditemukan hari ini",
            },
      });
    }

    // masukkan juga ke list untuk simulasi full
    schedules.push({
      id: r.id || `req-${Math.random().toString(36).slice(2, 9)}`,
      nama_perangkat: r.nama_perangkat,
      daya_watt: r.daya_watt,
      tipe: r.tipe,
      skor_prioritas: r.skor_prioritas || 0,
      mulai: r.mulai,
      selesai: r.selesai,
    });
  }

  // Jika ada konflik langsung dari request
  if (localConflicts.length > 0) {
    console.log("⚠️ Local conflict(s) ditemukan:");
    console.log(JSON.stringify(localConflicts, null, 2));
    return {
      ok: false,
      error: "Beban puncak terdeteksi pada jadwal yang diajukan",
      localConflicts,
    };
  }

  // 🔄 Simulasi global
  console.log("🔄 Menjalankan simulasi global...");
  const sim = await simulateLoadDynamic(schedules);
  if (sim.konflik.length === 0) {
    console.log("✅ Tidak ada konflik global.");
    return { ok: true, suggestions: [], simulate: sim };
  }

  console.log(
    `⚠️ Konflik global ditemukan: ${sim.konflik.length} interval overload`
  );
  sim.konflik.forEach((k) =>
    console.log(
      `⏰ Interval ${k.interval.mulai}-${k.interval.selesai}, Load ${k.load}W > ${k.kapasitasWatt}W`
    )
  );

  const suggestions = suggestShiftsDynamic(schedules, sim.kapasitasWatt);

  console.log("💡 Saran shifting:");
  console.log(suggestions);

  const simAfter = await simulateLoadDynamic(schedules);

  console.log(
    `📊 Setelah shifting: ${simAfter.konflik.length} konflik tersisa (ok=${
      simAfter.konflik.length === 0
    })`
  );

  return {
    ok: simAfter.konflik.length === 0,
    suggestions,
    localConflicts,
    simulateBefore: sim,
    simulateAfter: simAfter,
  };
}

module.exports = { simulateAndRecommendDynamic };
