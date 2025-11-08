const { Perangkat, DataPenggunaan } = require("../models");
const { Op } = require("sequelize");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");

exports.index = async (req, res) => {
  try {
    const data = await DataPenggunaan.findAll();
    res.render("laporan/index", { title: "Laporan", data });
  } catch (err) {
    console.error(err);
    res.status(500).send("Gagal load halaman Laporan");
  }
};

exports.getData = async (req, res) => {
  try {
    const { tanggal } = req.query;
    if (!tanggal) {
      return res.status(400).json({
        status: "error",
        message: "Tanggal wajib diisi",
      });
    }

    const startDate = new Date(`${tanggal} 00:00:00`);
    const endDate = new Date(`${tanggal} 23:59:59`);

    const data = await DataPenggunaan.findAll({
      where: {
        timestamp: {
          [Op.between]: [startDate, endDate],
        },
      },
      attributes: [
        "id",
        "perangkat_id",
        "volt",
        "ampere",
        "watt",
        "energy",
        "energy_delta",
        "timestamp",
      ],
      include: [
        {
          model: Perangkat,
          attributes: ["nama_perangkat"], // ambil cuma nama_perangkat
        },
      ],
      order: [["timestamp", "ASC"]],
    });

    return res.json({
      status: "success",
      data: data.map((d) => ({
        id: d.id,
        perangkat_id: d.perangkat_id,
        nama_perangkat: d.Perangkat ? d.Perangkat.nama_perangkat : null,
        volt: d.volt,
        ampere: d.ampere,
        watt: d.watt,
        energy: d.energy,
        energy_delta: d.energy_delta,
        timestamp: d.timestamp,
      })),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      status: "error",
      message: "Terjadi kesalahan server",
    });
  }
};

exports.exportExcel = async (req, res) => {
  try {
    const { tanggal } = req.query;
    if (!tanggal) {
      return res.status(400).json({
        status: "error",
        message: "Tanggal wajib diisi",
      });
    }

    // Buat range waktu dari awal sampai akhir hari
    const startDate = new Date(`${tanggal} 00:00:00`);
    const endDate = new Date(`${tanggal} 23:59:59`);

    // Ambil data dari DB
    const data = await DataPenggunaan.findAll({
      where: {
        timestamp: {
          [Op.between]: [startDate, endDate],
        },
      },
      attributes: [
        "id",
        "perangkat_id",
        "volt",
        "ampere",
        "watt",
        "energy",
        "energy_delta",
        "timestamp",
      ],
      include: [
        {
          model: Perangkat,
          attributes: ["nama_perangkat"],
        },
      ],
      order: [["timestamp", "ASC"]],
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Laporan Energi");

    sheet.columns = [
      { header: "Tanggal & Waktu", key: "tanggal", width: 20 },
      { header: "Nama Perangkat", key: "nama_perangkat" },
      { header: "Volt (V)", key: "volt" },
      { header: "Ampere (A)", key: "ampere" },
      { header: "Watt (W)", key: "watt" },
      { header: "Energy Δ (kWh)", key: "energy_delta" },
    ];

    data.forEach((d) => {
      sheet.addRow({
        tanggal: d.timestamp,
        nama_perangkat: d.nama_perangkat,
        volt: d.volt,
        ampere: d.ampere,
        watt: d.watt,
        energy_delta: d.energy_delta,
      });
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=Laporan_${tanggal}.xlsx`
    );
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("❌ Gagal export Excel:", err.message);
    res.status(500).send("Gagal export Excel");
  }
};

exports.exportPDF = async (req, res) => {
  try {
    const { tanggal } = req.query;
    if (!tanggal) {
      return res.status(400).json({
        status: "error",
        message: "Tanggal wajib diisi",
      });
    }

    const startDate = new Date(`${tanggal} 00:00:00`);
    const endDate = new Date(`${tanggal} 23:59:59`);

    const data = await DataPenggunaan.findAll({
      where: {
        timestamp: {
          [Op.between]: [startDate, endDate],
        },
      },
      attributes: ["volt", "ampere", "watt", "energy_delta", "timestamp"],
      include: [
        {
          model: Perangkat,
          attributes: ["nama_perangkat"],
        },
      ],
      order: [["timestamp", "ASC"]],
    });

    const doc = new PDFDocument({ margin: 30, size: "A4" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=Laporan_${tanggal}.pdf`
    );
    doc.pipe(res);

    // ===== Judul Laporan =====
    doc
      .font("Helvetica-Bold") // Bold untuk judul
      .fontSize(16)
      .text("Laporan Energi Harian", { align: "center" })
      .moveDown();
    doc
      .font("Helvetica")
      .fontSize(12)
      .text(`Tanggal: ${tanggal}`, { align: "center" })
      .moveDown(2);

    // ===== Header Tabel =====
    const tableTop = doc.y;
    const colWidths = [130, 120, 60, 70, 60, 80];
    const headers = [
      "Tanggal & Waktu",
      "Nama Perangkat",
      "Volt (V)",
      "Ampere (A)",
      "Watt (W)",
      "Energy Delta (kWh)",
    ];

    // Bold header
    doc.font("Helvetica-Bold");
    headers.forEach((header, i) => {
      doc.text(
        header,
        30 + colWidths.slice(0, i).reduce((a, b) => a + b, 0),
        tableTop,
        {
          width: colWidths[i],
          align: "center",
        }
      );
    });

    // Garis bawah header
    const headerBottomY = tableTop + 30;
    doc
      .moveTo(30, headerBottomY)
      .lineTo(30 + colWidths.reduce((a, b) => a + b, 0), headerBottomY)
      .stroke();

    // ===== Isi Tabel =====
    doc.font("Helvetica"); // Kembali normal
    let y = headerBottomY + 25;
    data.forEach((d) => {
      const row = [
        d.timestamp.toLocaleString(),
        d.Perangkat?.nama_perangkat || "-",
        d.volt,
        d.ampere,
        d.watt,
        d.energy_delta,
      ];

      row.forEach((text, i) => {
        doc.text(
          String(text),
          30 + colWidths.slice(0, i).reduce((a, b) => a + b, 0),
          y,
          {
            width: colWidths[i],
            align: "center",
          }
        );
      });

      y += 20;

      // Auto page break
      if (y > 750) {
        doc.addPage();
        y = 50;
      }
    });

    doc.end();
  } catch (err) {
    console.error("❌ Gagal export PDF:", err.message);
    res.status(500).send("Gagal export PDF");
  }
};
