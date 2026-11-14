// The models TableSpace offers: GGUF files run by llama.cpp compiled to
// WebAssembly (wllama), inside the page. Each URL is pinned to an immutable
// Hugging Face commit and carries the file's size and sha256 (the LFS oid),
// checked after download and before anything loads it. wllama loads single
// files up to 2 GB.

export type ModelDef = {
  id: string;
  name: string;
  family: string;
  size: string;
  bytes: number;
  url: string;
  sha256: string;
  note: string;
  /** Qwen3-style `<think>` support, toggled by `enable_thinking`. */
  thinking: boolean;
  n_ctx: number;
  /** Small enough to load on a phone beside the 3D scene (phones list only these). */
  phone?: boolean;
};

// A commit URL always serves the same bytes; `main` can be moved under us.
const HF = (repo: string, commit: string, file: string) => `https://huggingface.co/${repo}/resolve/${commit}/${file}`;

export const MODELS: ModelDef[] = [
  {
    id: 'qwen3-0.6b',
    name: 'Qwen3 0.6B',
    family: 'Q8_0 · 596M params',
    size: '639 MB',
    bytes: 639_446_688,
    url: HF('Qwen/Qwen3-0.6B-GGUF', '23749fefcc72300e3a2ad315e1317431b06b590a', 'Qwen3-0.6B-Q8_0.gguf'),
    sha256: '9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031',
    note: 'Fast. Picks tools reliably; its explanations are short.',
    thinking: true,
    n_ctx: 4096,
  },
  {
    id: 'qwen3-1.7b',
    name: 'Qwen3 1.7B',
    family: 'Q4_K_M · 1.7B params',
    size: '1.1 GB',
    bytes: 1_107_409_472,
    url: HF('unsloth/Qwen3-1.7B-GGUF', 'd7f544eead698dbd1f15126ef60b45a1e1933222', 'Qwen3-1.7B-Q4_K_M.gguf'),
    sha256: 'b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897',
    note: 'Noticeably smarter, about half the speed. Best on a computer with a GPU.',
    thinking: true,
    n_ctx: 4096,
  },
  {
    // iOS closes a tab past its memory limit, and the 3D scene holds part of it: the Q8_0 file (639 MB)
    // reloaded the page on an iPhone. Q4_K_M is the same 0.6B model in 397 MB (measured in BloomGrid, D-108).
    id: 'qwen3-0.6b-q4',
    name: 'Qwen3 0.6B · phone',
    family: 'Q4_K_M · 596M params',
    size: '397 MB',
    bytes: 396_705_472,
    url: HF('unsloth/Qwen3-0.6B-GGUF', '50968a4468ef4233ed78cd7c3de230dd1d61a56b', 'Qwen3-0.6B-Q4_K_M.gguf'),
    sha256: 'ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a',
    note: 'For phones: the 0.6B model in a smaller file, so it fits in the memory a phone gives a page. A little less precise.',
    thinking: true,
    n_ctx: 4096,
    phone: true,
  },
];

export const DEFAULT_MODEL = 'qwen3-0.6b';
/** The models this device can run: on phones only the `phone` ones. */
export const availableModels = (mobile: boolean): ModelDef[] => MODELS.filter((m) => !mobile || m.phone);
/** What to suggest first. */
export const recommendedModel = (mobile: boolean): ModelDef => MODELS.find((m) => (mobile ? m.phone : m.id === DEFAULT_MODEL))!;
export const modelById = (id: string | null | undefined) => MODELS.find((m) => m.id === id);
