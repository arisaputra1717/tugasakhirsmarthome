// utils/autoResumePause.js
const cron = require("node-cron");
const resumePausedDevices = require("../services/resumePause");

function initResumePauseScheduler() {
  // Cron jalan tiap menit
  cron.schedule("* * * * *", async () => {
    try {
      console.log("⏱️ [Scheduler] Cek perangkat Pause/Rekomendasi...");
      await resumePausedDevices();
    } catch (err) {
      console.error("❌ Error di resumePausedDevices:", err);
    }
  });
}

module.exports = initResumePauseScheduler;
