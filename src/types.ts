export interface Env {
	ASSETS: Fetcher;
}

export type TarGzIndexEntry = {
	path: string;
	mimeType: string;
	size: number;
	aStart: number;
	aFirstEnd: number;
	aFinalStart: number;
	aEnd: number;
	rStartOffset: number;
	rEndOffset: number;
	tarAStart: number;
	tarAFirstEnd: number;
	tarAFinalStart: number;
	tarAEnd: number;
	tarStartOffset: number;
	tarEndOffset: number;
};
