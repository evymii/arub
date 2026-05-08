import { v2 as cloudinary } from "cloudinary";

import { cloudinaryConfigured, env } from "./env.js";

if (cloudinaryConfigured) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
  });
}

export { cloudinary, cloudinaryConfigured };

export async function uploadBuffer(
  buffer: Buffer,
  folder: string,
): Promise<{ secureUrl: string; publicId: string }> {
  if (!cloudinaryConfigured) {
    throw new Error("Cloudinary credentials are not configured.");
  }
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image" },
      (err, result) => {
        if (err || !result) {
          reject(err ?? new Error("Cloudinary upload returned no result"));
          return;
        }
        resolve({ secureUrl: result.secure_url, publicId: result.public_id });
      },
    );
    stream.end(buffer);
  });
}

export async function deletePublicId(publicId: string): Promise<void> {
  if (!cloudinaryConfigured) return;
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (e) {
    console.warn("Cloudinary delete failed:", e);
  }
}
