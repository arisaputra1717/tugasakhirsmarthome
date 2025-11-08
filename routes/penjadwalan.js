const express = require('express');
const router = express.Router();
const controller = require('../controllers/penjadwalanController');

router.get('/', controller.index);
router.get('/create', controller.createForm);
router.post('/store', controller.store);
router.get('/edit/:id', controller.editForm);
router.post('/update/:id', controller.edit);
router.delete('/delete/:id', controller.delete);

module.exports = router;
