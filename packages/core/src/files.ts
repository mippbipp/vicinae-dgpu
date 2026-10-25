import { Effect, FileSystem, Path, Random } from "effect";

import { DgpuError } from "./errors.js";

export const failWith =
  (context: string) =>
  (cause: { readonly message: string }): DgpuError =>
    DgpuError.make({ message: `${context}: ${cause.message}`, cause });

export const isFile = Effect.fn("isFile")(function* (candidate: string) {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.stat(candidate).pipe(
    Effect.map((info) => info.type === "File"),
    Effect.catchReason("PlatformError", "NotFound", () =>
      Effect.succeed(false)
    ),
    Effect.mapError(failWith(`cannot inspect ${candidate}`))
  );
});

export const readText = Effect.fn("readText")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs
    .readFileString(filePath)
    .pipe(Effect.mapError(failWith(`cannot read ${filePath}`)));
});

/**
 * Writes through a hidden temporary file and a rename, so readers never see a
 * half-written file. Leaves the file alone when the content already matches.
 */
export const writeTextAtomically = Effect.fn("writeTextAtomically")(function* (
  filePath: string,
  text: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fail = failWith(`cannot write ${filePath}`);

  const current = (yield* isFile(filePath))
    ? yield* readText(filePath)
    : undefined;

  if (current === text) {
    return;
  }

  const directory = path.dirname(filePath);
  const nonce = (yield* Random.nextInt).toString(36);

  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${nonce}.tmp`
  );

  yield* fs
    .makeDirectory(directory, { recursive: true })
    .pipe(Effect.mapError(fail));

  yield* fs.writeFileString(temporary, text).pipe(Effect.mapError(fail));

  yield* fs.rename(temporary, filePath).pipe(
    Effect.mapError(fail),
    Effect.tapError(() =>
      fs.remove(temporary, { force: true }).pipe(Effect.ignore)
    )
  );
});
