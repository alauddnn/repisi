import React, { useState, useEffect, useRef } from 'react';
import {
  FileText,
  Upload,
  Search,
  Filter,
  Eye,
  Download,
  Edit2,
  Trash2,
  Plus,
  X,
  ExternalLink,
  AlertCircle,
  CheckCircle2,
  FileUp,
} from 'lucide-react';
import { Project, ProjectDocument, ProjectDocumentCategory } from '../types.js';
import { api } from '../lib/api.js';
import { formatDateID } from '../lib/utils.js';
import { useAuth } from '../context/AuthContext.js';

export const DOCUMENT_CATEGORIES: ProjectDocumentCategory[] = [
  'SPK',
  'MoU / Kontrak',
  'Faktur / Invoice',
  'Surat Jalan',
  'Berita Acara (BAST)',
  'Lainnya',
];

const CATEGORY_BADGE_STYLES: Record<string, string> = {
  SPK: 'bg-[#E1EBF9] text-[#284B80]',
  'MoU / Kontrak': 'bg-[#EDE6DF] text-[#44403C]',
  'Faktur / Invoice': 'bg-[#FCE8E6] text-[#9B1C1C]',
  'Surat Jalan': 'bg-[#E3EEDF] text-[#335426]',
  'Berita Acara (BAST)': 'bg-[#DCEFE9] text-[#1D5647]',
  Lainnya: 'bg-slate-100 text-slate-700',
};

function formatFileSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

function formatDateShort(isoOrDate?: string): string {
  if (!isoOrDate) return '-';
  try {
    const d = new Date(isoOrDate);
    if (isNaN(d.getTime())) return formatDateID(isoOrDate);
    return d.toLocaleDateString('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return formatDateID(isoOrDate);
  }
}

interface ProjectDocumentsModuleProps {
  project: Project;
  documents: ProjectDocument[];
  loading: boolean;
  onRefresh: () => Promise<void> | void;
  onStatsRefresh: () => Promise<void> | void;
  showToast: (type: 'success' | 'error' | 'info', message: string) => void;
  externalOpenUploadSignal?: number;
}

export const ProjectDocumentsModule: React.FC<ProjectDocumentsModuleProps> = ({
  project,
  documents,
  loading,
  onRefresh,
  onStatsRefresh,
  showToast,
  externalOpenUploadSignal = 0,
}) => {
  const { user, token, isAdmin, isOwner } = useAuth();

  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState<string>('ALL');

  // Upload / Edit Modal State
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [editingDoc, setEditingDoc] = useState<ProjectDocument | null>(null);
  const [formCategory, setFormCategory] = useState<string>('SPK');
  const [formFileName, setFormFileName] = useState<string>('');
  const [selectedPdfFile, setSelectedPdfFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Preview Modal State
  const [previewDoc, setPreviewDoc] = useState<ProjectDocument | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Delete Confirmation Modal State
  const [docToDelete, setDocToDelete] = useState<ProjectDocument | null>(null);
  const [deleting, setDeleting] = useState(false);

  const openUploadModal = () => {
    if (!isAdmin) return;
    setEditingDoc(null);
    setFormCategory('SPK');
    setFormFileName('');
    setSelectedPdfFile(null);
    setFileError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setIsUploadModalOpen(true);
  };

  useEffect(() => {
    if (externalOpenUploadSignal > 0 && isAdmin) {
      openUploadModal();
    }
  }, [externalOpenUploadSignal]);

  const openEditModal = (doc: ProjectDocument) => {
    if (!isAdmin) return;
    setEditingDoc(doc);
    setFormCategory(doc.category || 'Lainnya');
    setFormFileName(doc.fileName || '');
    setSelectedPdfFile(null);
    setFileError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setIsUploadModalOpen(true);
  };

  const getDocumentUrl = (docId: string, download: boolean = false) => {
    const params = new URLSearchParams();
    const storedToken = token || localStorage.getItem('kms_token');
    if (storedToken) {
      params.set('token', storedToken);
    }
    const role = user?.role || (isAdmin ? 'admin' : isOwner ? 'owner' : 'admin');
    const name = user?.name || (role === 'admin' ? 'Administrator Proyek' : 'Owner');
    params.set('role', role);
    params.set('userName', name);
    if (download) {
      params.set('download', 'true');
    }
    const qs = params.toString();
    return `/api/projects/documents/${docId}/view${qs ? `?${qs}` : ''}`;
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setFileError(null);
    if (!file) {
      setSelectedPdfFile(null);
      return;
    }

    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setFileError('Format file wajib PDF (.pdf).');
      setSelectedPdfFile(null);
      return;
    }
    if (file.size <= 0) {
      setFileError('File PDF kosong atau tidak valid.');
      setSelectedPdfFile(null);
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setFileError(`Ukuran file (${formatFileSize(file.size)}) melebihi batas maksimal 15 MB.`);
      setSelectedPdfFile(null);
      return;
    }

    setSelectedPdfFile(file);
    if (editingDoc && !formFileName.trim()) {
      setFormFileName(file.name);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) return;

    if (!editingDoc && !selectedPdfFile) {
      setFileError('Silakan pilih file PDF terlebih dahulu.');
      return;
    }

    setSubmitting(true);
    setFileError(null);
    try {
      if (editingDoc) {
        let uploadedPayload: {
          fileName: string;
          fileSize: number;
          mimeType: string;
          filePath?: string;
          storageBucket?: string;
          dataBase64?: string;
        } | null = null;

        if (selectedPdfFile) {
          uploadedPayload = await api.uploadProjectDocumentFile(project.id, selectedPdfFile);
        }

        const targetName = formFileName.trim() || selectedPdfFile?.name || editingDoc.fileName;
        await api.updateProjectDocument(project.id, editingDoc.id, {
          category: formCategory,
          fileName: targetName,
          ...(uploadedPayload
            ? {
                filePath: uploadedPayload.filePath,
                storageBucket: uploadedPayload.storageBucket,
                fileSize: uploadedPayload.fileSize,
                mimeType: uploadedPayload.mimeType,
                dataBase64: uploadedPayload.dataBase64,
              }
            : {}),
        });

        showToast('success', `Dokumen "${targetName}" berhasil diperbarui.`);
      } else if (selectedPdfFile) {
        const uploaded = await api.uploadProjectDocumentFile(project.id, selectedPdfFile);
        await api.createProjectDocument(project.id, {
          category: formCategory,
          fileName: uploaded.fileName,
          filePath: uploaded.filePath,
          storageBucket: uploaded.storageBucket,
          fileSize: uploaded.fileSize,
          mimeType: uploaded.mimeType,
          dataBase64: uploaded.dataBase64,
        });
        showToast('success', `Dokumen PDF "${uploaded.fileName}" berhasil diunggah.`);
      }

      setIsUploadModalOpen(false);
      setEditingDoc(null);
      setSelectedPdfFile(null);
      await Promise.all([onRefresh(), onStatsRefresh()]);
    } catch (err: any) {
      const msg = err?.message || 'Gagal menyimpan dokumen PDF.';
      setFileError(msg);
      showToast('error', msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!isAdmin || !docToDelete) return;
    setDeleting(true);
    try {
      const res = await api.deleteProjectDocument(project.id, docToDelete.id);
      showToast('success', res.message || `Dokumen "${docToDelete.fileName}" berhasil dihapus.`);
      setDocToDelete(null);
      await Promise.all([onRefresh(), onStatsRefresh()]);
    } catch (err: any) {
      showToast('error', err?.message || 'Gagal menghapus dokumen.');
    } finally {
      setDeleting(false);
    }
  };

  const q = searchQuery.toLowerCase().trim();
  const filteredDocuments = documents.filter((doc) => {
    const matchesSearch =
      !q ||
      (doc.fileName || '').toLowerCase().includes(q) ||
      (doc.category || '').toLowerCase().includes(q) ||
      (doc.uploadedBy || '').toLowerCase().includes(q);
    const matchesCat = filterCategory === 'ALL' || doc.category === filterCategory;
    return matchesSearch && matchesCat;
  });

  return (
    <div className="space-y-4 kms-fade-in">
      <div className="bg-white rounded-2xl border border-slate-200/90 shadow-[0_1px_3px_rgba(15,23,42,0.03)] overflow-hidden">
        {/* Header — Matched to Data Karyawan Proyek */}
        <div className="p-5 sm:p-6 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-baseline gap-2.5">
              <h3 className="text-base font-bold text-slate-900">Dokumen & Surat Proyek</h3>
              <span className="text-xs font-semibold text-[#155EEF] font-mono tabular-nums">
                {filteredDocuments.length} Dokumen PDF
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Arsip surat proyek <span className="font-semibold text-slate-700">{project.name}</span> (SPK, MoU / Kontrak, Faktur / Invoice, Surat Jalan, BAST). Khusus file PDF.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {isAdmin && (
              <button
                type="button"
                onClick={openUploadModal}
                className="bg-[#2563EB] hover:bg-[#1D4ED8] text-white px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all shadow-xs ml-auto sm:ml-0 cursor-pointer whitespace-nowrap shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Unggah PDF</span>
              </button>
            )}
          </div>
        </div>

        {/* Search & Filter Toolbar */}
        <div className="px-5 py-3.5 bg-slate-50/60 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="relative flex-1 max-w-md group">
            <Search className="w-4 h-4 text-slate-400 group-focus-within:text-[#2563EB] transition-colors absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari nama file PDF atau kategori surat..."
              className="w-full pl-10 pr-8 py-2 bg-white border border-slate-200 rounded-xl text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:border-[#2563EB] focus:ring-2 focus:ring-[#2563EB]/12"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 cursor-pointer"
                aria-label="Hapus pencarian"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5">
              <Filter className="w-3.5 h-3.5 text-slate-500" />
              <span className="text-xs text-slate-500">Kategori:</span>
              <select
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value)}
                className="px-3 py-1.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-800 focus:outline-none focus:border-[#2563EB]"
              >
                <option value="ALL">Semua Kategori ({documents.length})</option>
                {DOCUMENT_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>

            {(searchQuery || filterCategory !== 'ALL') && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setFilterCategory('ALL');
                }}
                className="text-xs text-[#2563EB] hover:underline px-1.5 py-1 cursor-pointer"
              >
                Reset Filter
              </button>
            )}
          </div>
        </div>

        {/* Bounded List Table (Max ~10 visible rows, internal vertical scroll for 11+) */}
        <div className="max-h-[620px] overflow-y-auto overscroll-contain overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <tbody className="divide-y divide-slate-200/75 text-slate-700">
              {loading ? (
                Array.from({ length: 4 }).map((_, idx) => (
                  <tr key={`doc-skel-${idx}`}>
                    <td className="py-4 px-6">
                      <div className="flex items-center gap-3.5">
                        <div className="w-10 h-10 rounded-full kms-skeleton shrink-0" />
                        <div className="space-y-1.5">
                          <div className="h-4 w-48 rounded kms-skeleton" />
                          <div className="h-3 w-32 rounded kms-skeleton" />
                        </div>
                      </div>
                    </td>
                    <td className="py-4 px-4"><div className="h-6 w-28 rounded-lg kms-skeleton" /></td>
                    <td className="py-4 px-4"><div className="h-4 w-32 rounded kms-skeleton" /></td>
                    <td className="py-4 px-6 text-right"><div className="h-8 w-36 rounded-lg kms-skeleton ml-auto" /></td>
                  </tr>
                ))
              ) : filteredDocuments.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-14 text-center text-slate-500">
                    <FileText className="w-9 h-9 text-slate-300 mx-auto mb-2.5" />
                    <p className="font-semibold text-slate-800">
                      {documents.length === 0
                        ? 'Belum ada surat atau dokumen PDF pada proyek ini.'
                        : 'Tidak ada dokumen PDF yang sesuai dengan pencarian atau filter kategori.'}
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      {documents.length === 0
                        ? 'Unggah dokumen SPK, MoU / Kontrak, Faktur, Surat Jalan, atau Berita Acara dalam format PDF.'
                        : 'Coba ubah kata kunci pencarian atau pilih "Semua Kategori".'}
                    </p>
                    {isAdmin && documents.length === 0 && (
                      <button
                        type="button"
                        onClick={openUploadModal}
                        className="mt-4 inline-flex items-center gap-1.5 bg-[#2563EB] hover:bg-[#1D4ED8] text-white px-4 py-2 rounded-xl text-xs font-semibold transition-colors cursor-pointer"
                      >
                        <Upload className="w-3.5 h-3.5" />
                        <span>Unggah PDF Pertama</span>
                      </button>
                    )}
                  </td>
                </tr>
              ) : (
                filteredDocuments.map((doc) => {
                  const badgeStyle = CATEGORY_BADGE_STYLES[doc.category] || CATEGORY_BADGE_STYLES.Lainnya;
                  const downloadHref = getDocumentUrl(doc.id, true);

                  return (
                    <tr key={doc.id} className="hover:bg-slate-50/90 transition-colors">
                      {/* Col 1: PDF Icon + File Name & Metadata */}
                      <td className="py-3.5 px-6 whitespace-nowrap">
                        <div className="flex items-center gap-3.5">
                          <div className="w-10 h-10 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center shrink-0 border border-rose-100">
                            <FileText className="w-4 h-4" />
                          </div>
                          <div className="min-w-0 max-w-[260px] sm:max-w-sm">
                            <button
                              type="button"
                              onClick={() => {
                                setPreviewLoading(true);
                                setPreviewDoc(doc);
                              }}
                              className="text-[13.5px] font-semibold text-slate-900 hover:text-[#2563EB] transition-colors leading-snug truncate block text-left w-full cursor-pointer"
                              title={`Preview ${doc.fileName}`}
                            >
                              {doc.fileName}
                            </button>
                            <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-1.5">
                              <span className="font-mono text-[11px] text-rose-700 font-semibold">PDF</span>
                              <span className="text-slate-300" aria-hidden="true">·</span>
                              <span className="font-mono text-[11px] tabular-nums text-slate-500">
                                {formatFileSize(doc.fileSize)}
                              </span>
                              <span className="text-slate-300" aria-hidden="true">·</span>
                              <span className="text-[11px] text-slate-400 tabular-nums">
                                {formatDateShort(doc.createdAt)}
                              </span>
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Col 2: Category Tag */}
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium ${badgeStyle}`}>
                          {doc.category}
                        </span>
                      </td>

                      {/* Col 3: Uploader & Upload Timestamp */}
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <div className="text-xs font-medium text-slate-700">
                          {doc.uploadedBy || 'Administrator'}
                        </div>
                        <div className="text-[11px] text-slate-400 tabular-nums mt-0.5">
                          Diunggah {formatDateShort(doc.createdAt)}
                        </div>
                      </td>

                      {/* Col 4: Actions (Preview, Unduh, Admin: Edit & Hapus) */}
                      <td className="py-3.5 px-6 text-right whitespace-nowrap">
                        <div className="inline-flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              setPreviewLoading(true);
                              setPreviewDoc(doc);
                            }}
                            className="px-2.5 py-1.5 bg-[#EFF5FF] hover:bg-[#DBEAFE] text-[#155EEF] border border-[#D0E2FF] rounded-lg text-[11px] font-semibold transition-colors inline-flex items-center gap-1.5 cursor-pointer"
                            title="Preview PDF"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            <span>Preview</span>
                          </button>

                          <a
                            href={downloadHref}
                            download={doc.fileName}
                            className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 rounded-lg text-[11px] font-semibold transition-colors inline-flex items-center gap-1.5"
                            title="Unduh File PDF"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span className="hidden sm:inline">Unduh</span>
                          </a>

                          {isAdmin && (
                            <>
                              <button
                                type="button"
                                onClick={() => openEditModal(doc)}
                                className="p-1.5 text-slate-400 hover:text-[#2563EB] hover:bg-blue-50 rounded-lg transition-colors cursor-pointer"
                                title="Edit Kategori / Ganti File PDF"
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setDocToDelete(doc)}
                                className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
                                title="Hapus Dokumen"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {filteredDocuments.length > 0 && (
          <div className="px-5 py-3 bg-slate-50/70 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
            <span>
              Menampilkan <strong className="text-slate-700 font-mono tabular-nums">{filteredDocuments.length}</strong> dokumen PDF tersimpan.
            </span>
            <span>
              Format khusus PDF (maks. 15 MB) · Tersimpan aman di penyimpanan proyek.
            </span>
          </div>
        )}
      </div>

      {/* MODAL 1: UNGGAH / EDIT DOKUMEN PDF (Admin Only) */}
      {isUploadModalOpen && isAdmin && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xl w-full max-w-[500px] max-h-[90vh] flex flex-col overflow-hidden kms-fade-in">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-blue-50 text-[#2563EB] flex items-center justify-center shrink-0">
                  <FileUp className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    {editingDoc ? 'Edit Dokumen PDF' : 'Unggah Surat / Dokumen PDF'}
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    Proyek: {project.name} ({project.code})
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => !submitting && setIsUploadModalOpen(false)}
                disabled={submitting}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-5 space-y-4 overflow-y-auto text-xs">
              <div>
                <label className="block font-semibold text-slate-700 mb-1.5">
                  Kategori Dokumen
                </label>
                <select
                  value={formCategory}
                  onChange={(e) => setFormCategory(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-900 focus:outline-none focus:border-[#2563EB] focus:ring-2 focus:ring-[#2563EB]/12"
                >
                  {DOCUMENT_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>

              {editingDoc && (
                <div>
                  <label className="block font-semibold text-slate-700 mb-1.5">
                    Nama Dokumen
                  </label>
                  <input
                    type="text"
                    value={formFileName}
                    onChange={(e) => setFormFileName(e.target.value)}
                    placeholder="Contoh: SPK_Proyek_Merak.pdf"
                    className="w-full px-3.5 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-900 focus:outline-none focus:border-[#2563EB] focus:ring-2 focus:ring-[#2563EB]/12"
                  />
                </div>
              )}

              <div>
                <label className="block font-semibold text-slate-700 mb-1.5">
                  {editingDoc ? 'Ganti File PDF (Opsional)' : 'Pilih File PDF'}
                </label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  onChange={handleFileChange}
                  className="hidden"
                  id="project-doc-pdf-input"
                />
                <label
                  htmlFor="project-doc-pdf-input"
                  className={`flex flex-col items-center justify-center p-6 border-2 border-dashed rounded-xl cursor-pointer transition-colors text-center ${
                    selectedPdfFile
                      ? 'border-emerald-300 bg-emerald-50/50'
                      : fileError
                      ? 'border-rose-300 bg-rose-50/40'
                      : 'border-slate-300 hover:border-[#2563EB] bg-slate-50/60 hover:bg-blue-50/30'
                  }`}
                >
                  {selectedPdfFile ? (
                    <>
                      <CheckCircle2 className="w-7 h-7 text-emerald-600 mb-2" />
                      <span className="font-semibold text-slate-900 break-all">
                        {selectedPdfFile.name}
                      </span>
                      <span className="text-[11px] text-emerald-700 font-mono mt-1">
                        PDF · {formatFileSize(selectedPdfFile.size)} (Siap diunggah)
                      </span>
                      <span className="text-[11px] text-[#2563EB] underline mt-2">
                        Klik untuk mengganti file lain
                      </span>
                    </>
                  ) : (
                    <>
                      <Upload className="w-7 h-7 text-slate-400 mb-2" />
                      <span className="font-semibold text-slate-800">
                        {editingDoc
                          ? 'Klik untuk memilih file PDF pengganti'
                          : 'Klik untuk memilih file PDF'}
                      </span>
                      <span className="text-[11px] text-slate-500 mt-1">
                        Khusus format <strong className="text-slate-700">.pdf</strong> (maks. 15 MB)
                      </span>
                      {editingDoc && (
                        <span className="text-[11px] text-slate-400 mt-2 break-all">
                          File saat ini: {editingDoc.fileName} ({formatFileSize(editingDoc.fileSize)})
                        </span>
                      )}
                    </>
                  )}
                </label>
              </div>

              {fileError && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 flex items-start gap-2 text-[11px]">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{fileError}</span>
                </div>
              )}

              <div className="pt-2 flex items-center justify-end gap-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsUploadModalOpen(false)}
                  disabled={submitting}
                  className="px-4 py-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-xl text-xs font-semibold transition-colors cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={submitting || (!editingDoc && !selectedPdfFile)}
                  className="px-4 py-2 bg-[#2563EB] hover:bg-[#1D4ED8] disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-xl text-xs font-semibold transition-colors inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>
                    {submitting
                      ? 'Mengunggah...'
                      : editingDoc
                      ? 'Simpan Perubahan'
                      : 'Unggah PDF'}
                  </span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: PREVIEW PDF + TOMBOL UNDUH (Admin & Owner) */}
      {previewDoc && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-3 sm:p-5">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden kms-fade-in">
            <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 bg-white">
              <div className="flex items-center gap-2.5 min-w-0 flex-1">
                <div className="w-9 h-9 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center shrink-0">
                  <FileText className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-slate-900 truncate">
                    {previewDoc.fileName}
                  </h3>
                  <div className="text-[11px] text-slate-500 flex items-center gap-1.5">
                    <span className="font-medium text-slate-700">{previewDoc.category}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">{formatFileSize(previewDoc.fileSize)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatDateShort(previewDoc.createdAt)}</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <a
                  href={getDocumentUrl(previewDoc.id, false)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Buka Tab Baru</span>
                </a>

                <a
                  href={getDocumentUrl(previewDoc.id, true)}
                  download={previewDoc.fileName}
                  className="px-3.5 py-1.5 bg-[#2563EB] hover:bg-[#1D4ED8] text-white rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 transition-colors shadow-xs"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Unduh PDF</span>
                </a>

                <button
                  type="button"
                  onClick={() => setPreviewDoc(null)}
                  className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
                  aria-label="Tutup preview"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="relative flex-1 bg-slate-100 min-h-[60vh] sm:min-h-[70vh]">
              {previewLoading && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-xs text-slate-500 bg-slate-50/90 z-10 pointer-events-none">
                  <div className="w-7 h-7 border-2 border-slate-200 border-t-[#2563EB] rounded-full animate-spin mb-2" />
                  <span>Memuat dokumen PDF...</span>
                </div>
              )}
              <iframe
                src={getDocumentUrl(previewDoc.id, false)}
                title={previewDoc.fileName}
                onLoad={() => setPreviewLoading(false)}
                className="w-full h-[65vh] sm:h-[72vh] border-0 bg-white"
              />
            </div>

            <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-200 text-[11px] text-slate-500 flex flex-wrap items-center justify-between gap-2">
              <span>
                Jika preview PDF tidak tampil langsung di browser HP, tekan tombol <strong>Buka Tab Baru</strong> atau <strong>Unduh PDF</strong> di kanan atas.
              </span>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 3: KONFIRMASI HAPUS DOKUMEN (Admin Only) */}
      {docToDelete && isAdmin && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xl w-full max-w-[420px] overflow-hidden kms-fade-in">
            <div className="p-5 border-b border-slate-100 bg-[#FEF3F2] flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-[#FEE4E2] text-[#D92D20] flex items-center justify-center shrink-0">
                  <Trash2 className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">Hapus Dokumen PDF?</h3>
                  <p className="text-[11px] text-slate-600">Kategori: {docToDelete.category}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => !deleting && setDocToDelete(null)}
                disabled={deleting}
                className="p-1 text-slate-500 hover:text-slate-900 rounded-lg cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-3 text-xs">
              <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-1">
                <p className="font-semibold text-slate-900 break-all">{docToDelete.fileName}</p>
                <p className="text-[11px] text-slate-500">
                  PDF · {formatFileSize(docToDelete.fileSize)} · Diunggah {formatDateShort(docToDelete.createdAt)}
                </p>
              </div>
              <p className="text-slate-600 leading-relaxed">
                Dokumen PDF ini akan dihapus secara permanen dari daftar proyek dan penyimpanan cloud. Tindakan ini tidak dapat dibatalkan.
              </p>
            </div>

            <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setDocToDelete(null)}
                disabled={deleting}
                className="px-4 py-2 bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 rounded-xl text-xs font-semibold cursor-pointer"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={deleting}
                className="px-4 py-2 bg-[#D92D20] hover:bg-[#B42318] text-white rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{deleting ? 'Menghapus...' : 'Ya, Hapus Permanen'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
