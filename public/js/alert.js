// public/js/alert.js
function showAlert({ title = "Info", text = "", icon = "info", timer = 5000 }) {
    Swal.fire({
        title,
        text,
        icon,
        timer,
        showConfirmButton: false,
        timerProgressBar: true,
    });
}

// Supaya bisa dipanggil dari EJS langsung
window.showAlert = showAlert;
