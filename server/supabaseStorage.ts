import { createClient, SupabaseClient } from '@supabase/supabase-js';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const DEFAULT_SUPABASE_URL = 'https://wrphgazcvapjbwlaryny.supabase.co';
export const EXPENSE_BUCKET_NAME = 'expense-receipts';
export const DOCUMENT_BUCKET_NAME = 'project-documents';
export const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB (for images)
export const MAX_DOCUMENT_FILE_SIZE = 15 * 1024 * 1024; // 15 MB (for PDFs via signed upload)
export const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
export const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

// Storage directory for local fallback (resilience across offline / test setups)
const UPLOADS_DIR = path.resolve(process.cwd(), 'data', 'uploads', 'expense-receipts');
const DOCUMENTS_UPLOADS_DIR = path.resolve(process.cwd(), 'data', 'uploads', 'project-documents');

function ensureUploadsDir() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
}

function ensureDocumentsUploadsDir() {
  if (!fs.existsSync(DOCUMENTS_UPLOADS_DIR)) {
    fs.mkdirSync(DOCUMENTS_UPLOADS_DIR, { recursive: true });
  }
}

// Retrieve configured Supabase URL & Key from server environment
export function getBackendSupabaseUrl(): string {
  return (
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    DEFAULT_SUPABASE_URL
  );
}

export function getBackendSupabaseKey(): string {
  return (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    ''
  );
}

let supabaseAdminClient: SupabaseClient | null = null;

export function getBackendSupabaseClient(): SupabaseClient | null {
  const key = getBackendSupabaseKey();
  if (!key || key.trim().length < 20 || key.includes('your-anon-key')) {
    return null;
  }

  if (!supabaseAdminClient) {
    const url = getBackendSupabaseUrl();
    try {
      supabaseAdminClient = createClient(url, key, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      });
    } catch (err) {
      console.error('Failed to initialize Supabase Storage client:', err);
      return null;
    }
  }

  return supabaseAdminClient;
}

export function isSupabaseStorageAvailable(): boolean {
  return Boolean(getBackendSupabaseClient());
}

// Magic number validation to prevent spoofed file extensions
export function validateImageBuffer(buffer: Buffer, fileName: string, declaredMimeType: string): { valid: boolean; error?: string; mimeType: string } {
  if (!buffer || buffer.length === 0) {
    return { valid: false, error: 'File foto kosong / tidak valid.', mimeType: '' };
  }

  if (buffer.length > MAX_FILE_SIZE) {
    const sizeMb = (buffer.length / (1024 * 1024)).toFixed(2);
    return {
      valid: false,
      error: `Ukuran file foto (${sizeMb} MB) melebihi batas maksimal 5 MB.`,
      mimeType: '',
    };
  }

  const ext = path.extname(fileName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return {
      valid: false,
      error: `Ekstensi file '${ext}' tidak didukung. Harap gunakan format JPG, JPEG, PNG, atau WebP.`,
      mimeType: '',
    };
  }

  // Detect signature from magic bytes
  let detectedMime = '';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    detectedMime = 'image/jpeg';
  } else if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    detectedMime = 'image/png';
  } else if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    detectedMime = 'image/webp';
  }

  if (!detectedMime) {
    // If declared MIME is in allowed list and extension matches, accept as fallback
    if (ALLOWED_MIME_TYPES.includes(declaredMimeType.toLowerCase())) {
      detectedMime = declaredMimeType.toLowerCase();
    } else {
      return {
        valid: false,
        error: 'Konten file bukan merupakan format gambar yang valid (hanya JPG, PNG, WebP).',
        mimeType: '',
      };
    }
  }

  return { valid: true, mimeType: detectedMime };
}

// Upload file to Supabase Storage private bucket, with local fallback
export async function uploadToStorage(
  buffer: Buffer,
  originalFileName: string,
  mimeType: string,
  expenseId: string
): Promise<{ filePath: string; storageType: 'supabase' | 'local'; signedUrl?: string }> {
  const ext = path.extname(originalFileName).toLowerCase() || '.jpg';
  const cleanBase = path
    .basename(originalFileName, ext)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 40);
  const uniqueId = crypto.randomBytes(6).toString('hex');
  const remotePath = `${expenseId}/${Date.now()}_${uniqueId}_${cleanBase}${ext}`;

  const client = getBackendSupabaseClient();
  if (client) {
    try {
      const { data, error } = await client.storage
        .from(EXPENSE_BUCKET_NAME)
        .upload(remotePath, buffer, {
          contentType: mimeType,
          upsert: true,
        });

      if (error) {
        console.warn('Supabase Storage upload warning (fallback to local if bucket not found):', error.message);
      } else if (data?.path) {
        // Generate signed URL for private bucket (valid 1 hour)
        const { data: signedData } = await client.storage
          .from(EXPENSE_BUCKET_NAME)
          .createSignedUrl(data.path, 3600);

        return {
          filePath: data.path,
          storageType: 'supabase',
          signedUrl: signedData?.signedUrl || undefined,
        };
      }
    } catch (err: any) {
      console.error('Error uploading to Supabase Storage:', err);
    }
  }

  // Local persistent fallback
  ensureUploadsDir();
  const localSubdir = path.join(UPLOADS_DIR, expenseId);
  if (!fs.existsSync(localSubdir)) {
    fs.mkdirSync(localSubdir, { recursive: true });
  }
  const localFileName = `${Date.now()}_${uniqueId}_${cleanBase}${ext}`;
  const fullPath = path.join(localSubdir, localFileName);
  fs.writeFileSync(fullPath, buffer);

  return {
    filePath: `local://${expenseId}/${localFileName}`,
    storageType: 'local',
  };
}

// Generate signed URL for private bucket file
export async function getAttachmentSignedUrl(filePath: string, expiresIn = 3600): Promise<string | null> {
  if (filePath.startsWith('local://')) {
    return null;
  }
  const client = getBackendSupabaseClient();
  if (!client) return null;

  try {
    const { data, error } = await client.storage
      .from(EXPENSE_BUCKET_NAME)
      .createSignedUrl(filePath, expiresIn);

    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}

// Download file buffer for authenticated streaming / viewing
export async function downloadAttachmentBuffer(
  filePath: string
): Promise<{ buffer: Buffer; mimeType: string; fileName: string } | null> {
  if (filePath.startsWith('local://')) {
    const relative = filePath.replace('local://', '');
    const fullPath = path.join(UPLOADS_DIR, relative);
    if (fs.existsSync(fullPath)) {
      const buf = fs.readFileSync(fullPath);
      const ext = path.extname(fullPath).toLowerCase();
      let mime = 'image/jpeg';
      if (ext === '.png') mime = 'image/png';
      else if (ext === '.webp') mime = 'image/webp';
      return { buffer: buf, mimeType: mime, fileName: path.basename(fullPath) };
    }
    return null;
  }

  const client = getBackendSupabaseClient();
  if (client) {
    try {
      const { data, error } = await client.storage.from(EXPENSE_BUCKET_NAME).download(filePath);
      if (error || !data) {
        console.warn('Failed to download from Supabase Storage:', error?.message);
      } else {
        const arrayBuf = await data.arrayBuffer();
        const buf = Buffer.from(arrayBuf);
        const ext = path.extname(filePath).toLowerCase();
        let mime = data.type || 'image/jpeg';
        if (ext === '.png') mime = 'image/png';
        else if (ext === '.webp') mime = 'image/webp';
        return { buffer: buf, mimeType: mime, fileName: path.basename(filePath) };
      }
    } catch (err) {
      console.error('Error downloading from Supabase Storage:', err);
    }
  }

  // Fallback: check if also saved locally
  const localFallbackPath = path.join(UPLOADS_DIR, filePath);
  if (fs.existsSync(localFallbackPath)) {
    const buf = fs.readFileSync(localFallbackPath);
    return { buffer: buf, mimeType: 'image/jpeg', fileName: path.basename(filePath) };
  }

  return null;
}

// Delete file from storage
export async function deleteFromStorage(filePath: string): Promise<boolean> {
  if (filePath.startsWith('local://')) {
    const relative = filePath.replace('local://', '');
    const fullPath = path.join(UPLOADS_DIR, relative);
    try {
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
      return true;
    } catch {
      return false;
    }
  }

  const client = getBackendSupabaseClient();
  if (client) {
    try {
      const { error } = await client.storage.from(EXPENSE_BUCKET_NAME).remove([filePath]);
      if (!error) return true;
    } catch (err) {
      console.error('Error deleting from Supabase Storage:', err);
    }
  }

  // Also remove local copy if exists
  const localFallbackPath = path.join(UPLOADS_DIR, filePath);
  if (fs.existsSync(localFallbackPath)) {
    try {
      fs.unlinkSync(localFallbackPath);
    } catch {}
  }

  return true;
}

// ============================================================================
// PDF DOCUMENT STORAGE HELPERS (Module G: Dokumen Proyek)
// Supports dedicated 'project-documents' bucket with auto-fallback to 'expense-receipts' or local disk
// ============================================================================

export function validatePdfBuffer(
  buffer: Buffer,
  fileName: string,
  declaredMimeType?: string
): { valid: boolean; error?: string; mimeType: string } {
  if (!buffer || buffer.length === 0) {
    return { valid: false, error: 'File PDF kosong atau tidak valid.', mimeType: '' };
  }

  if (buffer.length > MAX_DOCUMENT_FILE_SIZE) {
    const sizeMb = (buffer.length / (1024 * 1024)).toFixed(2);
    return {
      valid: false,
      error: `Ukuran file PDF (${sizeMb} MB) melebihi batas maksimal 15 MB.`,
      mimeType: '',
    };
  }

  const ext = path.extname(fileName || '').toLowerCase();
  if (ext !== '.pdf') {
    return {
      valid: false,
      error: `Format file '${ext || 'tidak diketahui'}' tidak didukung. Khusus untuk dokumen PDF (.pdf).`,
      mimeType: '',
    };
  }

  // Check PDF magic bytes (%PDF-) within the first 1024 bytes (per PDF spec)
  const headerSlice = buffer.subarray(0, Math.min(1024, buffer.length)).toString('ascii');
  if (!headerSlice.includes('%PDF-')) {
    return {
      valid: false,
      error: 'Konten file bukan dokumen PDF yang valid (%PDF header tidak ditemukan).',
      mimeType: '',
    };
  }

  const mime = declaredMimeType && declaredMimeType.toLowerCase().includes('pdf')
    ? 'application/pdf'
    : 'application/pdf';

  return { valid: true, mimeType: mime };
}

let cachedResolvedDocBucket: string | null = null;

async function resolveDocumentBucket(client: SupabaseClient): Promise<string> {
  if (cachedResolvedDocBucket) return cachedResolvedDocBucket;

  try {
    const { data: existingBucket, error: getErr } = await client.storage.getBucket(DOCUMENT_BUCKET_NAME);
    if (existingBucket && !getErr) {
      cachedResolvedDocBucket = DOCUMENT_BUCKET_NAME;
      return DOCUMENT_BUCKET_NAME;
    }

    // Attempt to auto-create private bucket dedicated for project PDF documents
    const { error: createErr } = await client.storage.createBucket(DOCUMENT_BUCKET_NAME, {
      public: false,
      fileSizeLimit: MAX_DOCUMENT_FILE_SIZE,
      allowedMimeTypes: ['application/pdf'],
    });
    if (!createErr) {
      cachedResolvedDocBucket = DOCUMENT_BUCKET_NAME;
      return DOCUMENT_BUCKET_NAME;
    }
  } catch (err: any) {
    console.warn('Notice checking/creating project-documents bucket:', err?.message || err);
  }

  // Do not permanently cache fallback in case bucket is created later, just test expense-receipts
  return EXPENSE_BUCKET_NAME;
}

function buildDocumentRemotePath(projectId: string, originalFileName: string): string {
  const safeProj = String(projectId || 'general').replace(/[^a-zA-Z0-9_-]/g, '_');
  const ext = '.pdf';
  const cleanBase = path
    .basename(originalFileName || 'dokumen.pdf', path.extname(originalFileName || '.pdf'))
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 60) || 'dokumen';
  const uniqueId = crypto.randomBytes(6).toString('hex');
  return `project-documents/${safeProj}/${Date.now()}_${uniqueId}_${cleanBase}${ext}`;
}

export async function createDocumentSignedUpload(
  projectId: string,
  originalFileName: string
): Promise<{ signedUrl: string; token: string; path: string; bucket: string } | null> {
  const client = getBackendSupabaseClient();
  if (!client) return null;

  const remotePath = buildDocumentRemotePath(projectId, originalFileName);
  const preferredBucket = await resolveDocumentBucket(client);
  const candidateBuckets = Array.from(new Set([preferredBucket, DOCUMENT_BUCKET_NAME, EXPENSE_BUCKET_NAME]));

  for (const bucket of candidateBuckets) {
    try {
      const { data, error } = await client.storage
        .from(bucket)
        .createSignedUploadUrl(remotePath, { upsert: true });

      if (!error && data?.signedUrl && data?.token) {
        cachedResolvedDocBucket = bucket;
        return {
          signedUrl: data.signedUrl,
          token: data.token,
          path: data.path || remotePath,
          bucket,
        };
      }
    } catch (err: any) {
      console.warn(`Signed upload URL attempt failed on bucket '${bucket}':`, err?.message || err);
    }
  }

  return null;
}

export async function uploadDocumentToStorage(
  buffer: Buffer,
  originalFileName: string,
  projectId: string
): Promise<{ filePath: string; storageBucket: string; storageType: 'supabase' | 'local'; signedUrl?: string }> {
  const remotePath = buildDocumentRemotePath(projectId, originalFileName);
  const client = getBackendSupabaseClient();

  if (client) {
    const preferredBucket = await resolveDocumentBucket(client);
    const candidateBuckets = Array.from(new Set([preferredBucket, DOCUMENT_BUCKET_NAME, EXPENSE_BUCKET_NAME]));

    for (const bucket of candidateBuckets) {
      try {
        const { data, error } = await client.storage
          .from(bucket)
          .upload(remotePath, buffer, {
            contentType: 'application/pdf',
            upsert: true,
          });

        if (!error && data?.path) {
          cachedResolvedDocBucket = bucket;
          const { data: signedData } = await client.storage
            .from(bucket)
            .createSignedUrl(data.path, 3600);

          return {
            filePath: data.path,
            storageBucket: bucket,
            storageType: 'supabase',
            signedUrl: signedData?.signedUrl || undefined,
          };
        }
        if (error) {
          console.warn(`Supabase PDF upload attempt on bucket '${bucket}' failed:`, error.message);
        }
      } catch (err: any) {
        console.warn(`Error uploading PDF to bucket '${bucket}':`, err?.message || err);
      }
    }
  }

  // Local persistent fallback (safe for local dev / offline usage)
  ensureDocumentsUploadsDir();
  const safeProj = String(projectId || 'general').replace(/[^a-zA-Z0-9_-]/g, '_');
  const localSubdir = path.join(DOCUMENTS_UPLOADS_DIR, safeProj);
  if (!fs.existsSync(localSubdir)) {
    fs.mkdirSync(localSubdir, { recursive: true });
  }
  const localFileName = path.basename(remotePath);
  const fullPath = path.join(localSubdir, localFileName);
  fs.writeFileSync(fullPath, buffer);

  return {
    filePath: `local-doc://${safeProj}/${localFileName}`,
    storageBucket: 'local',
    storageType: 'local',
  };
}

export async function getDocumentSignedUrl(
  filePath: string,
  bucketName?: string,
  expiresIn = 3600
): Promise<string | null> {
  if (!filePath || filePath.startsWith('local-doc://') || filePath.startsWith('local://')) {
    return null;
  }
  const client = getBackendSupabaseClient();
  if (!client) return null;

  const buckets = Array.from(
    new Set([bucketName, DOCUMENT_BUCKET_NAME, EXPENSE_BUCKET_NAME].filter(Boolean) as string[])
  );

  for (const bucket of buckets) {
    try {
      const { data, error } = await client.storage.from(bucket).createSignedUrl(filePath, expiresIn);
      if (!error && data?.signedUrl) {
        return data.signedUrl;
      }
    } catch {}
  }

  return null;
}

export async function downloadDocumentBuffer(
  filePath: string,
  bucketName?: string
): Promise<{ buffer: Buffer; mimeType: string; fileName: string } | null> {
  if (!filePath) return null;

  if (filePath.startsWith('local-doc://')) {
    const relative = filePath.replace('local-doc://', '');
    const fullPath = path.join(DOCUMENTS_UPLOADS_DIR, relative);
    if (fs.existsSync(fullPath)) {
      return {
        buffer: fs.readFileSync(fullPath),
        mimeType: 'application/pdf',
        fileName: path.basename(fullPath),
      };
    }
    return null;
  }

  if (filePath.startsWith('local://')) {
    const relative = filePath.replace('local://', '');
    const fullPath = path.join(UPLOADS_DIR, relative);
    if (fs.existsSync(fullPath)) {
      return {
        buffer: fs.readFileSync(fullPath),
        mimeType: 'application/pdf',
        fileName: path.basename(fullPath),
      };
    }
    return null;
  }

  const client = getBackendSupabaseClient();
  if (client) {
    const buckets = Array.from(
      new Set([bucketName, DOCUMENT_BUCKET_NAME, EXPENSE_BUCKET_NAME].filter(Boolean) as string[])
    );

    for (const bucket of buckets) {
      try {
        const { data, error } = await client.storage.from(bucket).download(filePath);
        if (!error && data) {
          const arrayBuf = await data.arrayBuffer();
          return {
            buffer: Buffer.from(arrayBuf),
            mimeType: 'application/pdf',
            fileName: path.basename(filePath),
          };
        }
      } catch (err: any) {
        console.warn(`Error downloading PDF from bucket '${bucket}':`, err?.message || err);
      }
    }
  }

  const localFallbackPath = path.join(DOCUMENTS_UPLOADS_DIR, filePath);
  if (fs.existsSync(localFallbackPath)) {
    return {
      buffer: fs.readFileSync(localFallbackPath),
      mimeType: 'application/pdf',
      fileName: path.basename(filePath),
    };
  }

  return null;
}

export async function deleteDocumentFromStorage(filePath: string, bucketName?: string): Promise<boolean> {
  if (!filePath) return true;

  if (filePath.startsWith('local-doc://')) {
    const relative = filePath.replace('local-doc://', '');
    const fullPath = path.join(DOCUMENTS_UPLOADS_DIR, relative);
    try {
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  const client = getBackendSupabaseClient();
  if (client) {
    const buckets = Array.from(
      new Set([bucketName, DOCUMENT_BUCKET_NAME, EXPENSE_BUCKET_NAME].filter(Boolean) as string[])
    );
    for (const bucket of buckets) {
      try {
        const { error } = await client.storage.from(bucket).remove([filePath]);
        if (!error) return true;
      } catch {}
    }
  }

  return true;
}
