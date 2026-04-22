import type { PermissionMode } from '../../types/common.js';

interface BaseMetadataFields {
  summary?: string;
  shouldExitLoop?: boolean;
  targetMode?: PermissionMode;
  modelId?: string;
  model?: string;
}

interface FileMetadataFields extends BaseMetadataFields {
  file_path: string;
  file_size?: number;
  last_modified?: string;
}

interface DiffMetadataFields extends FileMetadataFields {
  kind: 'edit';
  oldContent: string;
  newContent?: string;
  snapshot_created?: boolean;
  session_id?: string;
  message_id?: string;
}

interface ReadMetadataFields extends FileMetadataFields {
  file_type: string;
  encoding: string;
  is_binary?: boolean;
  lines_read?: number;
  total_lines?: number;
  start_line?: number;
  end_line?: number;
}

interface WriteMetadataFields extends DiffMetadataFields {
  content_size: number;
  encoding: string;
  created_directories?: boolean;
  has_diff?: boolean;
}

interface EditMetadataFields extends DiffMetadataFields {
  matches_found: number;
  replacements_made: number;
  replace_all: boolean;
  old_string_length: number;
  new_string_length: number;
  original_size: number;
  new_size: number;
  size_diff: number;
  diff_snippet?: string | null;
}

interface EditErrorMetadataFields extends BaseMetadataFields {
  searchStringLength: number;
  fuzzyMatches: Array<{
    line: number;
    similarity: number;
    preview: string;
  }>;
  excerptRange: [number, number];
  totalLines: number;
}

interface GlobMetadataFields extends BaseMetadataFields {
  search_path: string;
  pattern: string;
  total_matches: number;
  returned_matches: number;
  max_results: number;
  include_directories?: boolean;
  case_sensitive?: boolean;
  truncated: boolean;
  matches?: Array<{
    path: string;
    relative_path: string;
    is_directory: boolean;
    mtime?: number;
  }>;
}

interface GrepMetadataFields extends BaseMetadataFields {
  search_pattern: string;
  search_path: string;
  output_mode: string;
  case_insensitive?: boolean;
  total_matches: number;
  original_total?: number;
  offset?: number;
  head_limit?: number;
  strategy?: string;
  exit_code?: number;
}

interface BashBackgroundMetadataFields extends BaseMetadataFields {
  command: string;
  background: true;
  pid: number;
  bash_id: string;
  shell_id: string;
  message?: string;
}

interface BashForegroundMetadataFields extends BaseMetadataFields {
  command: string;
  background?: false;
  execution_time: number;
  exit_code: number | null;
  signal?: NodeJS.Signals | null;
  stdout_length?: number;
  stderr_length?: number;
  has_stderr?: boolean;
}

interface WebSearchMetadataFields extends BaseMetadataFields {
  query: string;
  provider: string;
  fetched_at: string;
  total_results: number;
  returned_results: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

interface WebFetchMetadataFields extends BaseMetadataFields {
  url: string;
  method: string;
  status: number;
  response_time: number;
  content_length: number;
  redirected: boolean;
  redirect_count: number;
  final_url?: string;
  content_type?: string;
  redirect_chain?: string[];
}

type Metadata<T extends BaseMetadataFields = BaseMetadataFields> = T & {
  [key: string]: unknown;
};

export type ReadMetadata = Metadata<ReadMetadataFields>;
export type WriteMetadata = Metadata<WriteMetadataFields>;
export type EditMetadata = Metadata<EditMetadataFields>;
export type EditErrorMetadata = Metadata<EditErrorMetadataFields>;
export type GlobMetadata = Metadata<GlobMetadataFields>;
export type GrepMetadata = Metadata<GrepMetadataFields>;
export type BashBackgroundMetadata = Metadata<BashBackgroundMetadataFields>;
export type BashForegroundMetadata = Metadata<BashForegroundMetadataFields>;
export type WebSearchMetadata = Metadata<WebSearchMetadataFields>;
export type WebFetchMetadata = Metadata<WebFetchMetadataFields>;

export type ToolResultMetadata = Metadata<BaseMetadataFields>;

export function isGlobMetadata(metadata: ToolResultMetadata | undefined): metadata is GlobMetadata {
  return (
    metadata !== undefined &&
    typeof metadata.pattern === 'string' &&
    typeof metadata.search_path === 'string'
  );
}

export function isEditMetadata(metadata: ToolResultMetadata | undefined): metadata is EditMetadata {
  return (
    metadata !== undefined && metadata.kind === 'edit' && typeof metadata.matches_found === 'number'
  );
}
