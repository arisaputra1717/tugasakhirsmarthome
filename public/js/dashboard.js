let pendingDeviceId = null;
let pendingCommand = null;

document.addEventListener("DOMContentLoaded", () => {
  // ====== Tombol ON/OFF perangkat ======
  document.querySelectorAll("button[data-device-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.getAttribute("data-device-id");
      const command = button.getAttribute("data-command");
      const isPenjadwalanAktif =
        button.getAttribute("data-penjadwalan") === "true";

      // Cek badge status di kartu yang sama, hindari kirim command duplikat
      const statusBadge = button.closest(".card")?.querySelector(".badge");
      if (statusBadge) {
        const currentStatus = statusBadge.textContent.trim().toUpperCase();
        if (currentStatus === command) {
          button.disabled = true;
          return;
        }
      }

      if (isPenjadwalanAktif) {
        pendingDeviceId = id;
        pendingCommand = command;
        const modal = new bootstrap.Modal(
          document.getElementById("modalKonfirmasiManual")
        );
        modal.show();
      } else {
        kirimPerintah(id, command);
      }
    });
  });

  // ====== Konfirmasi override jadwal ======
  document
    .getElementById("btnKonfirmasiManual")
    ?.addEventListener("click", async () => {
      const modal = bootstrap.Modal.getInstance(
        document.getElementById("modalKonfirmasiManual")
      );
      modal.hide();

      if (pendingDeviceId && pendingCommand) {
        try {
          await kirimPerintah(pendingDeviceId, pendingCommand);
        } catch (err) {
          console.error("Gagal kirim perintah:", err);
          alert("Terjadi kesalahan saat memproses perintah");
        } finally {
          pendingDeviceId = null;
          pendingCommand = null;
        }
      }
    });

  // ====== Socket.IO ======
  const socket = io();
// Update panel Kuota/Terpakai/Sisa secara realtime dari server (mqttClient.js emit 'durasi-update')
socket.on("durasi-update", ({ id, durasi, kuota, persen }) => {
  const durEl = document.getElementById(`durasi-${id}`);
  const kuoEl = document.getElementById(`kuota-${id}`);
  const sisEl = document.getElementById(`sisa-${id}`);
  const barEl = document.getElementById(`durasi-bar-${id}`);

  if (typeof kuota === "number" && kuoEl) kuoEl.textContent = kuota.toFixed(2);
  if (typeof durasi === "number" && durEl) durEl.textContent = durasi.toFixed(2);
  if (sisEl && (typeof kuota === "number") && (typeof durasi === "number")) {
    const sisa = Math.max(0, kuota - durasi);
    sisEl.textContent = sisa.toFixed(2);
  }
  if (barEl && typeof persen === "number") {
    barEl.style.width = `${Math.min(100, Math.max(0, persen))}%`;
  }
});

  // Status perangkat
  socket.on("status-updated", ({ id, status }) => {
    updateButtonStatus(id, status);
    syncButtonStatusFromBadge();
  });

  // Data realtime meter
  socket.on("data-terbaru", ({ perangkat_id, volt, ampere, watt, energy }) => {
    updateDataRealtime(perangkat_id, { volt, ampere, watt, energy });
  });

  // Limit: payload lengkap (total, limit, persen)
  socket.on("limit-updated", (data) => {
    updateLimitDisplay(data);
  });

  // Fallback: beberapa halaman lama hanya kirim totalEnergiUpdate
  socket.on("totalEnergiUpdate", ({ total }) => {
    const t = parseFloat(total) || 0;

    // Ambil batas kWh dari DOM bila tidak dikirim di payload
    let batas = 0;
    const batasEl =
      document.querySelector("#batas-energi") ||
      document.querySelector("#batasEnergi") ||
      document.querySelector('[data-role="batas-energi"]');
    if (batasEl) {
      const m = (batasEl.textContent || "").match(/([\d.,]+)/);
      if (m) batas = parseFloat(m[1].replace(",", ".")) || 0;
    }
    const persen = batas > 0 ? Math.min(100, Math.round((t / batas) * 100)) : 0;

    updateLimitDisplay({
      totalEnergi: t,
      limit: batas ? { batas_kwh: batas } : null,
      persenLimit: persen,
    });
  });

  // Saat limit penuh, matikan semua tombol ON
  socket.on("limit-energi-full", () => {
    document.querySelectorAll('button[data-command="ON"]').forEach((b) => {
      b.disabled = true;
      b.title = "Limit energi penuh — tidak dapat dinyalakan";
    });
  });
});

// ====== Helpers UI ======
function updateButtonStatus(deviceId, status) {
  const btnOn = document.querySelector(
    `button[data-device-id="${deviceId}"][data-command="ON"]`
  );
  const btnOff = document.querySelector(
    `button[data-device-id="${deviceId}"][data-command="OFF"]`
  );
  const statusBadge = btnOn?.closest(".card")?.querySelector(".badge");

  if (btnOn && btnOff && statusBadge) {
    btnOn.classList.toggle("btn-success", status === "ON");
    btnOn.classList.toggle("btn-outline-success", status !== "ON");
    btnOff.classList.toggle("btn-danger", status === "OFF");
    btnOff.classList.toggle("btn-outline-danger", status !== "OFF");

    statusBadge.className = `badge rounded-pill bg-${
      status === "ON" ? "success" : "danger"
    }`;
    statusBadge.innerHTML = `<i class="fas fa-circle me-1"></i>${status}`;

    btnOn.disabled = status === "ON";
    btnOff.disabled = status === "OFF";
  }
}

function getTanggalJamDariWaktuSekarang() {
  const el = document.getElementById("waktuSekarang");
  if (!el) return null;

  const teks = el.textContent.trim(); // contoh: "Senin, 11 Agu 2025 14:30:45"
  const parts = teks.split(" ");
  if (parts.length < 5) return null;

  const tanggal = parts[1].padStart(2, "0");
  const bulanStr = parts[2];
  const tahun = parts[3];
  const waktu = parts[4];

  const bulanMap = {
    Jan: "01",
    Feb: "02",
    Mar: "03",
    April: "04",
    Mei: "05",
    Juni: "06",
    Juli: "07",
    Agu: "08",
    Sep: "09",
    Okt: "10",
    Nov: "11",
    Des: "12",
  };

  const bulan = bulanMap[bulanStr];
  if (!bulan) return null;

  const tanggalFormat = `${tahun}-${bulan}-${tanggal}`;
  const waktuParts = waktu.split(":");
  const jamMenitDetik = `${waktuParts[0]}:${waktuParts[1]}:${waktuParts[2]}`;
  return { tanggal: tanggalFormat, jamMenit: jamMenitDetik };
}

function updateDataRealtime(id, { volt, ampere, watt, energy }) {
  const setText = (selector, value, digits = 2) => {
    const el = document.getElementById(`${selector}-${id}`);
    if (el) el.textContent = parseFloat(value).toFixed(digits);
  };

  setText("volt", volt, 1);
  setText("ampere", ampere, 2);
  setText("watt", watt, 1);
  setText("energy", energy, 3);
}

// ====== FIX: selalu update Total Pemakaian, progress bar opsional ======
function updateLimitDisplay(limitData) {
  if (!limitData) return;

  const total = Number(limitData.totalEnergi) || 0;
  const limit = limitData.limit || null;

  const limitContainer = document.getElementById("limit-container");
  const tanggalMulaiEl =
    document.getElementById("tanggal-mulai") ||
    document.querySelector('[data-role="tanggal-mulai"]');
  const tanggalSelesaiEl =
    document.getElementById("tanggal-selesai") ||
    document.querySelector('[data-role="tanggal-selesai"]');
  const totalEnergiEl =
    document.getElementById("total-energi") ||
    document.getElementById("totalEnergi") ||
    document.querySelector('[data-role="total-energi"]');
  const batasEnergiEl =
    document.getElementById("batas-energi") ||
    document.getElementById("batasEnergi") ||
    document.querySelector('[data-role="batas-energi"]');
  const progressBar =
    document.getElementById("progress-bar") ||
    document.querySelector('[role="progressbar"]');

  if (limitContainer) limitContainer.style.display = "flex";

  // ✅ SELALU update angka total, tanpa bergantung elemen lain
  if (totalEnergiEl) totalEnergiEl.textContent = `${total.toFixed(2)} kWh`;

  // Tanggal (jika elemen ada & payload tersedia)
  if (limit?.tanggal_mulai && tanggalMulaiEl) {
    tanggalMulaiEl.textContent = new Date(limit.tanggal_mulai).toLocaleDateString(
      "id-ID",
      { dateStyle: "long" }
    );
  }
  if (limit?.tanggal_selesai && tanggalSelesaiEl) {
    tanggalSelesaiEl.textContent = new Date(limit.tanggal_selesai).toLocaleDateString(
      "id-ID",
      { dateStyle: "long" }
    );
  }

  // Batas kWh
  let batas = 0;
  if (limit && typeof limit.batas_kwh !== "undefined") {
    batas = Number(limit.batas_kwh) || 0;
    if (batasEnergiEl) batasEnergiEl.textContent = `${batas} kWh`;
  } else if (batasEnergiEl) {
    // fallback: ekstrak angka dari teks "Batas Energi: 10 kWh"
    const m = (batasEnergiEl.textContent || "").match(/([\d.,]+)/);
    if (m) batas = parseFloat(m[1].replace(",", ".")) || 0;
  }

  // Progress bar (opsional)
  if (progressBar) {
    const persen =
      batas > 0
        ? Math.max(0, Math.min(100, Math.round((total / batas) * 100)))
        : Number(limitData.persenLimit) || 0;

    progressBar.style.width = `${persen}%`;
    progressBar.textContent = `${persen}%`;
    progressBar.setAttribute("aria-valuenow", String(persen));

    const colorClass =
      persen < 60 ? "bg-success" : persen < 80 ? "bg-warning" : "bg-danger";
    progressBar.className = `progress-bar ${colorClass}`;
  }
}

function updateDeviceBlockStatus(deviceId, blocked) {
  const card = document
    .querySelector(`button[data-device-id="${deviceId}"]`)
    ?.closest(".card");
  if (!card) return;

  const btnOn = card.querySelector('button[data-command="ON"]');
  const blockIndicator = card.querySelector(".text-danger");
  const blockAlert = card.querySelector(".alert-danger");

  if (blocked) {
    if (btnOn) {
      btnOn.disabled = true;
      btnOn.title = "Tidak dapat dinyalakan karena limit energi tercapai";
    }

    if (!blockIndicator) {
      const headerDiv = card.querySelector(".card-header div");
      if (headerDiv) {
        const indicator = document.createElement("small");
        indicator.className = "text-danger";
        indicator.innerHTML =
          '<br><i class="fas fa-ban"></i> Diblokir oleh limit energi';
        headerDiv.appendChild(indicator);
      }
    }

    if (!blockAlert) {
      const cardBody = card.querySelector(".card-body");
      if (cardBody) {
        const alert = document.createElement("div");
        alert.className = "alert alert-danger p-1 mb-2 text-center";
        alert.innerHTML =
          '<i class="fas fa-exclamation-triangle me-1"></i> Tidak dapat dinyalakan karena limit energi';
        cardBody.insertBefore(alert, cardBody.firstChild);
      }
    }
  } else {
    if (btnOn) {
      btnOn.disabled = false;
      btnOn.title = "Kontrol manual";
    }
    if (blockIndicator) blockIndicator.remove();
    if (blockAlert) blockAlert.remove();
  }
}

function syncButtonStatusFromBadge() {
  document.querySelectorAll(".card").forEach((card) => {
    const badge = card.querySelector(".badge");
    if (!badge) return;

    const status = badge.textContent.trim().toUpperCase();
    const btnOn = card.querySelector('button[data-command="ON"]');
    const btnOff = card.querySelector('button[data-command="OFF"]');
    if (!btnOn || !btnOff) return;

    if (status === "ON") {
      btnOn.disabled = true;
      btnOff.disabled = false;
    } else if (status === "OFF") {
      btnOn.disabled = false;
      btnOff.disabled = true;
    } else {
      btnOn.disabled = false;
      btnOff.disabled = false;
    }
  });
}

// Jalankan fungsi ini saat halaman selesai load
window.addEventListener("load", () => {
  syncButtonStatusFromBadge();
});

// ====== Submit form kapasitas ======
document
  .getElementById("kapasitasForm")
  ?.addEventListener("submit", async function (e) {
    e.preventDefault();

    const form = e.target;
    const formData = Object.fromEntries(new FormData(form));

    try {
      const response = await fetch("/kapasitas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      const result = await response.json();

      showAlert({
        title: result.status === "success" ? "Berhasil" : "Gagal",
        text: result.message,
        icon: result.status,
      });

      if (result.status === "success") {
        form.reset();
        setTimeout(() => {
          window.location.reload();
        }, 1200);
      }
    } catch (err) {
      showAlert({
        title: "Error",
        text: "Terjadi kesalahan saat mengirim data",
        icon: "error",
      });
    }
  });

// ====== Kirim perintah ke server ======
async function kirimPerintah(id, perintah) {
  const btn = document.querySelector(
    `button[data-device-id="${id}"][data-command="${perintah}"]`
  );
  if (!btn) return;

  const originalContent = btn.innerHTML;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin me-1"></i> Memproses...';
  btn.disabled = true;

  const waktu = getTanggalJamDariWaktuSekarang();
  if (!waktu) {
    alert("Waktu saat ini tidak tersedia atau format tidak valid.");
    btn.innerHTML = originalContent;
    btn.disabled = false;
    return;
  }
  const { tanggal, jamMenit } = waktu;

  try {
    if (perintah === "OFF") {
      return eksekusiPerintah(id, perintah, tanggal, jamMenit, btn);
    }

    const cek = await fetch(`/perangkat/${id}/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: perintah,
        tanggal,
        jamMenit,
        confirm: false,
      }),
    }).then((res) => res.json());

    if (!cek.success) {
      const rekom = cek.rekomendasi || {};
      let perangkatPauseList = "";

      if (rekom.perangkatPause && rekom.perangkatPause.length) {
        perangkatPauseList = rekom.perangkatPause
          .map((p) => `${p.nama} (${p.daya}W)`)
          .join(", ");
      }

      if (rekom.error) {
        Swal.fire({
          title: "Tidak Bisa Menyalakan",
          html: `
            <p>${rekom.error}</p>
            <p>Sisa daya: <b>${rekom.sisaDaya ?? 0} W</b></p>
          `,
          icon: "error",
          confirmButtonText: "Tutup",
        }).then(() => {
          btn.innerHTML = originalContent;
          btn.disabled = false;
        });
        return;
      }

      Swal.fire({
        title: "Tidak Bisa Menyalakan",
        html: `
          <p>Beban puncak terdeteksi!</p>
          <p>Sisa daya: <b>${rekom.sisaDaya ?? 0} W</b></p>
          ${
            perangkatPauseList
              ? `<p>Perangkat yang bisa di-Pause sementara: ${perangkatPauseList}</p>`
              : ""
          }
          <p>Pilih durasi pause:</p>
          <div id="durasi-options" style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:10px;">
            ${
              Array.isArray(rekom.durasiPilihan) && rekom.durasiPilihan.length
                ? rekom.durasiPilihan
                    .map(
                      (d) =>
                        `<button type="button" class="swal2-styled durasi-btn" data-durasi="${d}">${d} mnt</button>`
                    )
                    .join("")
                : "<span>-</span>"
            }
          </div>
        `,
        icon: "warning",
        showCancelButton: true,
        showConfirmButton: false,
        cancelButtonText: "Tutup",
        didOpen: () => {
          document.querySelectorAll(".durasi-btn").forEach((btnOpt) => {
            btnOpt.addEventListener("click", () => {
              const durasi = btnOpt.getAttribute("data-durasi");
              Swal.close();
              eksekusiPerintah(id, perintah, tanggal, jamMenit, btn, true, durasi);
            });
          });
        },
      }).then((result) => {
        if (result.isConfirmed) {
          eksekusiPerintah(id, perintah, tanggal, jamMenit, btn, true);
        } else {
          btn.innerHTML = originalContent;
          btn.disabled = false;
        }
      });
      return;
    }

    eksekusiPerintah(id, perintah, tanggal, jamMenit, btn, true);
  } catch (err) {
    console.error("Error:", err);
    alert("Terjadi kesalahan: " + err.message);
    btn.innerHTML = originalContent;
    btn.disabled = false;
  }
}

// Eksekusi ON/OFF sesungguhnya
function eksekusiPerintah(
  id,
  perintah,
  tanggal,
  jamMenit,
  btn,
  confirmed = true,
  durasi = null
) {
  const originalContent = btn.innerHTML;

  fetch(`/perangkat/${id}/toggle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status: perintah,
      tanggal,
      jamMenit,
      confirm: confirmed,
      durasi,
    }),
  })
    .then((res) => res.json())
    .then((finalData) => {
      if (!finalData.success) throw new Error(finalData.message);

      updateButtonStatus(id, perintah);
      syncButtonStatusFromBadge();
      showAlert({
        title: "Berhasil",
        text: finalData.message,
        icon: "success",
      });

      if (finalData.rekomendasi) {
        console.log("Rekomendasi tambahan:", finalData.rekomendasi);
      }
    })
    .catch((err) => {
      console.error("Error:", err);
      alert("Terjadi kesalahan: " + err.message);
    })
    .finally(() => {
      btn.innerHTML = originalContent;
      btn.disabled = false;
    });
}
