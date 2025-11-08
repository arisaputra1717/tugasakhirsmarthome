const express = require('express');
const router = express.Router();
const controller = require('../controllers/limitController');

router.get('/', controller.index);
router.post('/', controller.store);
router.get('/:id/edit', controller.edit);
router.post('/:id/edit', controller.update);
router.post('/:id/delete', controller.destroy);

module.exports = router;
