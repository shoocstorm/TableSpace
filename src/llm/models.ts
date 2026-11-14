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
    note: 'Fast, and small enough for phones. Picks tools reliably; its explanations are short.',
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
];

export const DEFAULT_MODEL = 'qwen3-0.6b';
export const modelById = (id: string | null | undefined) => MODELS.find((m) => m.id === id);
