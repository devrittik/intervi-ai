# face-api.js model weights

Place these files (download from https://github.com/justadudewhohacks/face-api.js/tree/master/weights) here:

- `tiny_face_detector_model-weights_manifest.json`
- `tiny_face_detector_model-shard1`

Only TinyFaceDetector is required — other models are not loaded.

Quick download (run from this folder):

```bash
BASE=https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights
curl -sLO "$BASE/tiny_face_detector_model-weights_manifest.json"
curl -sLO "$BASE/tiny_face_detector_model-shard1"
```
