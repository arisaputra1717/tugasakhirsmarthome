const express = require('express');
const router = express.Router();
const kapasitasController = require('../controllers/kapasitasController');

// GET: tampilkan form & data
router.get('/', kapasitasController.index);

// POST: simpan data
router.post('/', kapasitasController.store);

module.exports = router;
