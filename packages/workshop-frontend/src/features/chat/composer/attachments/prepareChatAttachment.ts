import { formatAttachmentSize } from "../../attachmentFormatting";

export const MAX_CHAT_ATTACHMENT_BYTES = 1024 * 1024;
export const MAX_CHAT_ATTACHMENT_TOTAL_BYTES = 5 * 1024 * 1024;
/** Must match MAX_CONVERTIBLE_DOCUMENT_BYTES in the backend's chat-attachment-validation.ts. */
export const MAX_CONVERTIBLE_DOCUMENT_BYTES = 10 * 1024 * 1024;

// Documents the server may convert to Markdown instead of storing as-is. They are allowed to be
// far larger than a stored attachment because only the extracted text is kept. Whether a PDF
// actually converts depends on the selected model's provider, which the server decides -- a large
// PDF sent to a provider that reads PDFs natively is rejected there, by the stored-as-is cap.
// Must stay byte-identical to CONVERTIBLE_MIME_TYPES in the backend's chat-attachment-validation.ts.
const CONVERTIBLE_DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",       // .xlsx
  "application/vnd.ms-excel",                                                // .xls
  "application/vnd.ms-excel.sheet.macroenabled.12",                          // .xlsm
  "application/vnd.ms-excel.sheet.binary.macroenabled.12",                   // .xlsb
  "application/vnd.oasis.opendocument.text",                                 // .odt
  "application/vnd.oasis.opendocument.spreadsheet",                          // .ods
]);

export const isConvertibleDocumentMimeType = (mimeType: string): boolean =>
  CONVERTIBLE_DOCUMENT_MIME_TYPES.has(mimeType);
const MAX_CHAT_ATTACHMENT_SOURCE_IMAGE_BYTES = 25 * 1024 * 1024;
const CHAT_ATTACHMENT_IMAGE_MAX_EDGE = 1568;

const canvasToBlob = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("Failed to encode image.")),
      type,
      quality,
    );
  });

export const prepareChatAttachment = async (
  file: File,
): Promise<{ blob: Blob; mimeType: string }> => {
  if (!file.type.startsWith("image/")) {
    const limit = isConvertibleDocumentMimeType(file.type)
      ? MAX_CONVERTIBLE_DOCUMENT_BYTES
      : MAX_CHAT_ATTACHMENT_BYTES;
    if (file.size > limit) {
      throw new Error(`Attachments must be ${formatAttachmentSize(limit)} or smaller.`);
    }
    return { blob: file, mimeType: file.type || "application/octet-stream" };
  }
  if (file.size > MAX_CHAT_ATTACHMENT_SOURCE_IMAGE_BYTES) {
    throw new Error(
      `Images must be ${formatAttachmentSize(MAX_CHAT_ATTACHMENT_SOURCE_IMAGE_BYTES)} or smaller before resizing.`,
    );
  }

  const bitmap = await createImageBitmap(file);
  try {
    const supportedOriginalType = file.type === "image/jpeg" || file.type === "image/png" ||
      file.type === "image/webp";
    if (supportedOriginalType && file.size <= MAX_CHAT_ATTACHMENT_BYTES &&
        Math.max(bitmap.width, bitmap.height) <= CHAT_ATTACHMENT_IMAGE_MAX_EDGE) {
      return { blob: file, mimeType: file.type };
    }

    const scale = Math.min(1, CHAT_ATTACHMENT_IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Failed to get 2D canvas context.");
    context.drawImage(bitmap, 0, 0, width, height);

    // Retaining PNG/WebP avoids losing transparency and keeps the MIME type consistent with the
    // original filename extension.
    const outputMimeType = supportedOriginalType ? file.type : "image/jpeg";
    const quality = outputMimeType === "image/png" ? undefined : 0.85;
    const blob = await canvasToBlob(canvas, outputMimeType, quality);
    if (blob.size > MAX_CHAT_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachments must be ${formatAttachmentSize(MAX_CHAT_ATTACHMENT_BYTES)} or smaller.`,
      );
    }
    return { blob, mimeType: outputMimeType };
  } finally {
    bitmap.close();
  }
};
