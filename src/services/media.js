export async function prepareMediaPart(token, fileId, mimeType) {
  const getFileUrl = `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`;
  const fileRes = await fetch(getFileUrl);
  const fileData = await fileRes.json();
  if (!fileData.ok || !fileData.result?.file_path) {
    console.error("prepareMediaPart: getFile gagal", fileData);
    return null;
  }
  const downloadUrl = `https://api.telegram.org/file/bot${token}/${fileData.result.file_path}`;
  const mediaRes = await fetch(downloadUrl);
  if (!mediaRes.ok) {
    console.error("prepareMediaPart: download gagal", mediaRes.status);
    return null;
  }
  const buffer = await mediaRes.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return {
    inline_data: {
      mime_type: mimeType,
      data: base64,
    },
  };
}
