import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ArrowDown, ArrowDownToLine, ArrowRight, Check, CheckCheck, ChevronDown,
  CircleAlert, Clipboard, ExternalLink, Film, Image, Link2, LoaderCircle,
  LockKeyhole, Play, RotateCcw, ShieldCheck, Sparkles, X,
} from 'lucide-react';
import {
  downloadMedia, formatBytes, mediaUrl, resolveMedia, validateMediaUrl,
  type DownloadProgress, type ResolvedMedia,
} from '../lib/api';

const DEMO_URL = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';

type BatchItem = {
  key: string;
  url: string;
  status: 'waiting' | 'resolving' | 'ready' | 'error' | 'cancelled';
  media?: ResolvedMedia;
  error?: string;
};

type DownloaderProps = { onToast?: (message: string) => void; compact?: boolean };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

function isAborted(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

function MediaCard({ media, compact = false, onToast }: { media: ResolvedMedia; compact?: boolean; onToast: (message: string) => void }) {
  const reducedMotion = useReducedMotion();
  const qualityId = useId();
  const [formatId, setFormatId] = useState(media.formats[0].id);
  const [status, setStatus] = useState<'idle' | 'downloading' | 'success' | 'error'>('idle');
  const [progress, setProgress] = useState<DownloadProgress>({ received: 0 });
  const [error, setError] = useState('');
  const [previewFailed, setPreviewFailed] = useState(false);
  const downloadController = useRef<AbortController | null>(null);
  const format = media.formats.find((item) => item.id === formatId) || media.formats[0];
  const percentage = progress.total ? Math.min(100, Math.round(progress.received / progress.total * 100)) : undefined;

  useEffect(() => () => downloadController.current?.abort(), []);

  async function handleDownload() {
    downloadController.current?.abort();
    const controller = new AbortController();
    downloadController.current = controller;
    setProgress({ received: 0 });
    setError('');
    setStatus('downloading');
    try {
      await downloadMedia(media, format, controller.signal, setProgress);
      setStatus('success');
      onToast('Download ready. Your browser will save the original file.');
    } catch (caught) {
      if (isAborted(caught)) {
        setStatus('idle');
        onToast('Download cancelled. You can try again whenever you are ready.');
      } else {
        setError(errorMessage(caught));
        setStatus('error');
      }
    }
  }

  return (
    <motion.article
      className={`dl-result${compact ? ' dl-result-compact' : ''}`}
      initial={{ opacity: 0, y: reducedMotion ? 0 : 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reducedMotion ? 0 : 0.35 }}
    >
      <div className={`dl-preview${previewFailed ? ' dl-preview-failed' : ''}`}>
        {previewFailed ? (
          <div className="dl-preview-fallback">
            {media.kind === 'video' ? <Film size={28} /> : <Image size={28} />}
            <span>Preview unavailable</span>
            <span className="dl-preview-fallback-note">You can still try downloading the file.</span>
          </div>
        ) : media.kind === 'video' ? (
          <video
            src={mediaUrl(media.id, format.id)}
            controls playsInline preload="metadata"
            aria-label={`Video preview: ${media.title}`}
            onError={() => setPreviewFailed(true)}
          />
        ) : (
          <img src={mediaUrl(media.id, format.id)} alt={media.title || 'Resolved image preview'} loading="lazy" onError={() => setPreviewFailed(true)} />
        )}
        <span className="dl-preview-badge">{media.kind === 'video' ? <Film size={11} /> : <Image size={11} />}{format.extension.toUpperCase()}</span>
      </div>
      <div className="dl-result-body">
        <div className="dl-result-heading">
          <span className="dl-ready"><span /> Ready to download</span>
          <h3 title={media.title}>{media.title || 'Your media'}</h3>
          <div className="dl-meta">
            <span>{format.extension.toUpperCase()}</span>
            <span>{formatBytes(format.size)}</span>
            {format.width && format.height ? <span>{format.width} × {format.height}</span> : null}
          </div>
        </div>
        <div className="dl-result-actions">
          <div className="dl-quality">
            <label htmlFor={qualityId}>Quality</label>
            <div className="dl-quality-control">
              <select id={qualityId} value={formatId} disabled={status === 'downloading'} onChange={(event) => { setFormatId(event.target.value); setStatus('idle'); setPreviewFailed(false); }}>
                {media.formats.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
              <ChevronDown size={14} aria-hidden="true" />
            </div>
          </div>
          <motion.button
            type="button" className={`dl-download${status === 'success' ? ' is-success' : ''}`}
            disabled={status === 'downloading'} onClick={() => void handleDownload()}
            whileTap={reducedMotion ? undefined : { scale: 0.97 }}
          >
            {status === 'downloading' ? <LoaderCircle className="dl-spin" size={16} /> : status === 'success' ? <CheckCheck size={16} /> : <ArrowDownToLine size={16} />}
            {status === 'downloading' ? 'Downloading…' : status === 'success' ? 'Download again' : `Download ${format.extension.toUpperCase()}`}
          </motion.button>
        </div>
        <AnimatePresence initial={false}>
          {status === 'downloading' && (
            <motion.div className="dl-progress" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="dl-progress-info"><span>{formatBytes(progress.received)}{progress.total ? ` of ${formatBytes(progress.total)}` : ' received'}</span><button type="button" onClick={() => downloadController.current?.abort()}>Cancel <X size={11} /></button></div>
              <div className={`dl-progress-track${percentage === undefined ? ' is-indeterminate' : ''}`} role="progressbar" aria-label="Downloading media" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage} aria-valuetext={percentage === undefined ? `${formatBytes(progress.received)} received` : `${percentage}%`}>
                <span style={percentage === undefined ? undefined : { width: `${percentage}%` }} />
              </div>
            </motion.div>
          )}
          {status === 'success' && (
            <motion.div className="dl-success" role="status" initial={{ opacity: 0, y: reducedMotion ? 0 : 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <span className="dl-success-icon"><Check size={12} /></span> Your file is ready. Enjoy your flow.
              {!reducedMotion && <span className="dl-confetti" aria-hidden="true">{[0, 1, 2, 3, 4, 5].map((piece) => <i key={piece} style={{ '--piece': piece } as CSSProperties} />)}</span>}
            </motion.div>
          )}
        </AnimatePresence>
        {error && <div className="dl-error dl-card-error" role="alert"><CircleAlert size={15} /><span>{error}</span><button type="button" onClick={() => void handleDownload()}><RotateCcw size={12} /> Retry</button></div>}
      </div>
    </motion.article>
  );
}

export default function Downloader({ onToast, compact = false }: DownloaderProps) {
  const reducedMotion = useReducedMotion();
  const inputId = useId();
  const helperId = useId();
  const [mode, setMode] = useState<'single' | 'batch'>('single');
  const [url, setUrl] = useState('');
  const [batchText, setBatchText] = useState('');
  const [isResolving, setIsResolving] = useState(false);
  const [result, setResult] = useState<ResolvedMedia | null>(null);
  const [batch, setBatch] = useState<BatchItem[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pasted, setPasted] = useState(false);
  const [usingDemo, setUsingDemo] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const requestVersion = useRef(0);
  const pasteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isBatch = mode === 'batch';

  useEffect(() => () => {
    controllerRef.current?.abort();
    if (pasteTimer.current) clearTimeout(pasteTimer.current);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function notify(message: string) {
    if (onToast) onToast(message);
    else setNotice(message);
  }

  function changeMode(next: 'single' | 'batch') {
    if (next === mode) return;
    requestVersion.current += 1;
    controllerRef.current?.abort();
    setIsResolving(false);
    setBatch((current) => current.map((item) => item.status === 'waiting' || item.status === 'resolving' ? { ...item, status: 'cancelled' } : item));
    setError('');
    setMode(next);
  }

  async function pasteLink() {
    try {
      if (!navigator.clipboard?.readText) throw new Error('Clipboard unavailable');
      const text = await navigator.clipboard.readText();
      if (!text.trim()) { notify('Your clipboard is empty. Copy a media link first.'); return; }
      if (isBatch) setBatchText(text.trim());
      else setUrl(text.trim());
      setError('');
      setPasted(true);
      if (pasteTimer.current) clearTimeout(pasteTimer.current);
      pasteTimer.current = setTimeout(() => setPasted(false), 1800);
      if (isBatch) textareaRef.current?.focus();
      else inputRef.current?.focus();
    } catch {
      notify('Clipboard access is unavailable. Paste your link into the field using your keyboard or touch menu.');
      if (isBatch) textareaRef.current?.focus();
      else inputRef.current?.focus();
    }
  }

  async function resolveSingle(value = url, demo = false) {
    setError('');
    let normalized: string;
    try { normalized = validateMediaUrl(value); }
    catch (caught) { setError(errorMessage(caught)); inputRef.current?.focus(); return; }
    controllerRef.current?.abort();
    const controller = new AbortController();
    const version = ++requestVersion.current;
    controllerRef.current = controller;
    setIsResolving(true);
    setResult(null);
    setUsingDemo(demo);
    try {
      const media = await resolveMedia(normalized, controller.signal);
      if (requestVersion.current === version) setResult(media);
    } catch (caught) {
      if (requestVersion.current === version && !isAborted(caught)) setError(errorMessage(caught));
    } finally {
      if (requestVersion.current === version) setIsResolving(false);
    }
  }

  async function resolveBatch() {
    setError('');
    const lines = [...new Set(batchText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
    if (!lines.length) { setError('Add one public media URL per line to start your batch.'); textareaRef.current?.focus(); return; }
    if (lines.length > 5) { setError('You can resolve up to 5 unique links at a time.'); textareaRef.current?.focus(); return; }
    let items: BatchItem[];
    try {
      items = lines.map((line, index) => ({ key: `${Date.now()}-${index}`, url: validateMediaUrl(line), status: 'waiting' }));
    } catch (caught) { setError(errorMessage(caught)); return; }
    controllerRef.current?.abort();
    const controller = new AbortController();
    const version = ++requestVersion.current;
    controllerRef.current = controller;
    setIsResolving(true);
    setBatch(items);
    try {
      for (const item of items) {
        if (controller.signal.aborted || requestVersion.current !== version) break;
        setBatch((current) => current.map((entry) => entry.key === item.key ? { ...entry, status: 'resolving' } : entry));
        try {
          const media = await resolveMedia(item.url, controller.signal);
          if (requestVersion.current !== version) break;
          setBatch((current) => current.map((entry) => entry.key === item.key ? { ...entry, status: 'ready', media } : entry));
        } catch (caught) {
          if (isAborted(caught)) break;
          if (requestVersion.current !== version) break;
          setBatch((current) => current.map((entry) => entry.key === item.key ? { ...entry, status: 'error', error: errorMessage(caught) } : entry));
        }
      }
    } finally {
      if (requestVersion.current === version) {
        setBatch((current) => current.map((entry) => entry.status === 'waiting' || entry.status === 'resolving' ? { ...entry, status: 'cancelled' } : entry));
        setIsResolving(false);
      }
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isResolving) return;
    if (isBatch) void resolveBatch();
    else void resolveSingle();
  }

  function tryDemo() {
    if (isResolving) return;
    setMode('single');
    setUrl(DEMO_URL);
    void resolveSingle(DEMO_URL, true);
  }

  return (
    <div className={`dl-shell${compact ? ' dl-shell-compact' : ''}`}>
      <div className="dl-toolbar">
        <div className="dl-tabs" role="group" aria-label="Choose download mode">
          <button type="button" className={mode === 'single' ? 'is-active' : ''} aria-pressed={mode === 'single'} onClick={() => changeMode('single')}><Link2 size={14} /> Single link</button>
          <button type="button" className={mode === 'batch' ? 'is-active' : ''} aria-pressed={mode === 'batch'} onClick={() => changeMode('batch')}><span className="dl-batch-icon" aria-hidden="true">▤</span> Batch links <span className="dl-tab-new">NEW</span></button>
        </div>
        <span className="dl-trust"><span /> No sign-up needed</span>
      </div>
      <form onSubmit={handleSubmit} className="dl-form" aria-label="Media downloader">
        <div className={`dl-entry${isBatch ? ' dl-entry-batch' : ''}`}>
          <div className={`dl-field${(isBatch ? batchText : url) ? ' has-value' : ''}${error ? ' has-error' : ''}`}>
            <Link2 size={19} className="dl-input-icon" aria-hidden="true" />
            <label className="dl-field-label" htmlFor={inputId}>{isBatch ? 'Paste your media links, one per line' : 'Paste your video or image link here'}</label>
            {isBatch ? (
              <textarea id={inputId} ref={textareaRef} value={batchText} rows={3} maxLength={10_500} placeholder=" " aria-describedby={helperId} aria-invalid={Boolean(error)} disabled={isResolving} onChange={(event) => { setBatchText(event.target.value); setError(''); }} />
            ) : (
              <input id={inputId} ref={inputRef} type="url" value={url} maxLength={2048} placeholder=" " autoComplete="off" spellCheck={false} aria-describedby={helperId} aria-invalid={Boolean(error)} disabled={isResolving} onChange={(event) => { setUrl(event.target.value); setError(''); }} />
            )}
            <motion.button className="dl-paste" type="button" disabled={isResolving} onClick={() => void pasteLink()} whileTap={reducedMotion ? undefined : { scale: 0.93 }}>{pasted ? <Check size={13} /> : <Clipboard size={13} />}{pasted ? 'Pasted' : 'Paste'}</motion.button>
          </div>
          <motion.button className="dl-submit" type="submit" disabled={isResolving} whileTap={reducedMotion ? undefined : { scale: 0.97 }}>
            {isResolving ? <LoaderCircle className="dl-spin" size={17} /> : <ArrowDown size={18} />}
            <span>{isResolving ? 'Finding media…' : isBatch ? 'Find all media' : 'Download'}</span>
            {!isResolving && <ArrowRight size={15} className="dl-submit-arrow" />}
          </motion.button>
        </div>
        <div className="dl-helper" id={helperId}>
          <span><LockKeyhole size={11} />{isBatch ? 'Up to 5 links · Download each file individually' : 'Public, authorized media. Approved direct sources only.'}</span>
          {isResolving ? <button className="dl-cancel" type="button" onClick={() => controllerRef.current?.abort()}><X size={12} /> Cancel</button> : <button className="dl-demo" type="button" onClick={tryDemo}><Play size={10} fill="currentColor" /> Try a sample <ArrowRight size={11} /></button>}
        </div>
      </form>
      <AnimatePresence mode="wait" initial={false}>
        {error && (
          <motion.div key="error" className="dl-error" role="alert" initial={{ opacity: 0, y: reducedMotion ? 0 : -5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <CircleAlert size={16} /><span>{error}</span><button type="button" disabled={isResolving} onClick={() => isBatch ? void resolveBatch() : void resolveSingle()}><RotateCcw size={12} /> Try again</button>
          </motion.div>
        )}
        {!isBatch && isResolving && (
          <motion.div key="loading" className="dl-skeleton" role="status" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="dl-skeleton-preview"><LoaderCircle className="dl-spin" size={25} /></div>
            <div className="dl-skeleton-body"><span /><span /><span /><p>Checking your link and reading the original file…</p></div>
          </motion.div>
        )}
        {!isBatch && result && !isResolving && (
          <motion.div key={result.id} className="dl-resolved" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {usingDemo && <div className="dl-demo-caption"><Sparkles size={12} /> Real sample · Public-domain flower video from MDN <a href="https://developer.mozilla.org/en-US/docs/Web/HTML/Element/video" target="_blank" rel="noreferrer" aria-label="About the MDN sample video (opens a new tab)"><ExternalLink size={11} /></a></div>}
            <MediaCard media={result} onToast={notify} />
          </motion.div>
        )}
      </AnimatePresence>
      {isBatch && batch.length > 0 && (
        <div className="dl-batch-list" aria-live="polite" aria-atomic="false">
          <div className="dl-batch-summary"><span><CheckCheck size={13} />{batch.filter((item) => item.status === 'ready').length} of {batch.length} links ready</span><span>Original files. Individually saved.</span></div>
          {batch.map((item) => item.media ? (
            <MediaCard key={item.key} media={item.media} compact onToast={notify} />
          ) : (
            <div key={item.key} className={`dl-batch-item${item.status === 'error' ? ' has-error' : ''}`}>
              {item.status === 'error' ? <CircleAlert size={17} /> : item.status === 'resolving' ? <LoaderCircle className="dl-spin" size={17} /> : <Link2 size={17} />}
              <div><span className="dl-batch-url" title={item.url}>{item.url}</span><p>{item.error || (item.status === 'resolving' ? 'Checking source…' : item.status === 'cancelled' ? 'Cancelled. Submit your batch again to retry.' : 'Waiting for the previous link…')}</p></div>
            </div>
          ))}
        </div>
      )}
      {notice && <div className="dl-notice" role="status"><ShieldCheck size={14} /><span>{notice}</span><button type="button" onClick={() => setNotice('')} aria-label="Dismiss notification"><X size={13} /></button></div>}
    </div>
  );
}
