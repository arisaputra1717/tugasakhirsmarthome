const express = require('express');
const router = express.Router();
const statisticController = require('../controllers/statisticController');

router.get('/', statisticController.index);

// Endpoint untuk data grafik dengan query ?tanggal=YYYY-MM-DD
router.get('/data', statisticController.getChartData);

module.exports = router;
