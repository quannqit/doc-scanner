import type { EnhanceMode } from '../types.js';

export interface ScannerLabels {
  close: string;
  capture: string;
  pickPhoto: string;
  takePhoto: string;
  torch: string;
  zoom: string;
  switchCamera: string;
  camera: string;
  aimHint: string;
  holdHint: string;
  adjustHint: string;
  retake: string;
  crop: string;
  editCrop: string;
  addPage: string;
  done: string;
  processing: string;
  pages: (n: number) => string;
  noCamera: string;
  modes: Record<EnhanceMode, string>;
}

export const enLabels: ScannerLabels = {
  close: 'Close',
  capture: 'Capture',
  pickPhoto: 'Choose photo',
  takePhoto: 'Take photo',
  torch: 'Flash',
  zoom: 'Zoom',
  switchCamera: 'Switch camera',
  camera: 'Camera',
  aimHint: 'Point the camera at a document',
  holdHint: 'Document found — hold still and tap capture',
  adjustHint: 'Drag the corners to the edges of the document',
  retake: 'Retake',
  crop: 'Crop',
  editCrop: 'Edit crop',
  addPage: 'Add page',
  done: 'Done',
  processing: 'Processing…',
  pages: (n) => (n === 1 ? '1 page' : `${n} pages`),
  noCamera: 'The camera is not available here (it needs HTTPS and permission). You can still take or choose a photo.',
  modes: { color: 'Color', gray: 'Grayscale', bw: 'B&W', original: 'Original' },
};

export const viLabels: ScannerLabels = {
  close: 'Đóng',
  capture: 'Chụp',
  pickPhoto: 'Chọn ảnh',
  takePhoto: 'Chụp ảnh',
  torch: 'Đèn',
  zoom: 'Thu phóng',
  switchCamera: 'Đổi camera',
  camera: 'Camera',
  aimHint: 'Hướng camera vào tài liệu',
  holdHint: 'Đã thấy tài liệu — giữ yên và bấm chụp',
  adjustHint: 'Kéo các góc khớp với mép tài liệu',
  retake: 'Chụp lại',
  crop: 'Cắt',
  editCrop: 'Sửa khung',
  addPage: 'Thêm trang',
  done: 'Xong',
  processing: 'Đang xử lý…',
  pages: (n) => `${n} trang`,
  noCamera: 'Không mở được camera trong trình duyệt (cần HTTPS và quyền camera). Bạn vẫn có thể chụp hoặc chọn ảnh.',
  modes: { color: 'Màu', gray: 'Xám', bw: 'Đen trắng', original: 'Gốc' },
};
