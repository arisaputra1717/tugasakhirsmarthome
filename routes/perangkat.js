const express = require('express');
const router = express.Router();
const perangkatController = require('../controllers/perangkatController');

router.get('/', perangkatController.index);
router.get('/create', perangkatController.createForm);
router.post('/store', perangkatController.create);
router.get('/:id/edit', perangkatController.editForm);
router.post('/:id/update', perangkatController.edit);
router.delete('/:id/delete', perangkatController.delete);
router.post('/check', perangkatController.checkRecommendation);

// Route penting!
router.post('/:id/toggle', perangkatController.toggle);

module.exports = router;
