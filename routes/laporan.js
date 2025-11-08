const express = require('express');
const router = express.Router();
const laporanController = require('../controllers/laporanController');

router.get('/', laporanController.index);
// Endpoint untuk data dengan query ?tanggal=YYYY-MM-DD
router.get('/data', laporanController.getData);
router.get('/export/excel', laporanController.exportExcel);
router.get('/export/pdf', laporanController.exportPDF);

module.exports = router;
