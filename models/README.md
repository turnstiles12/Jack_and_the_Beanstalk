# Models (all run on the server with ONNX Runtime, CPU)

| File | What | Source / licence |
|---|---|---|
| `mtcnn_pnet.onnx`, `mtcnn_rnet.onnx`, `mtcnn_onet.onnx` | MTCNN face detector + 5 landmarks | Weights from `facenet-pytorch` 2.6.0 (MIT), converted with `scripts/convert-mtcnn.py` (byte-for-byte reproducible) |
| `face_recognition_sface_2021dec.onnx.part0` + `.part1` | SFace face-recognition model (128-d) | OpenCV Model Zoo (Apache-2.0); Zhong et al., "SFace: Sigmoid-Constrained Hypersphere Loss for Robust Face Recognition", 2021 |

SFace is split in two so each file stays under 30 MB. `src/face.js` joins the parts and refuses to start unless the
joined file's SHA-256 is `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79`.

Identity threshold: cosine similarity ≥ 0.40 (OpenCV suggests 0.363; we add margin against look-alikes).
