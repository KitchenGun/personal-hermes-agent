"""Bounded schema-1 exact-byte patch primitive (Python 3.8+).

Recipes contain inserted bytes, offsets, lengths, and complete file hashes, never
removed bytes. Inserted bytes have no source-secrecy guarantee. Trust, target
selection, source review, filesystem transactions, and rollback belong to callers.
"""

import base64
import binascii
import hashlib


MAX_FILE = 2 * 1024 * 1024
MAX_EDITS = 64
MAX_RECIPE = 512 * 1024
_MAX_BASE64 = 4 * ((MAX_FILE + 2) // 3)
_HEX = frozenset("0123456789abcdef")


class PatchRecipeError(ValueError):
    """The bytes or recipe do not satisfy the exact patch contract."""


def _fields(value, names, label):
    if (type(value) is not dict or len(value) != len(names)
            or any(type(key) is not str for key in value)
            or set(value) != names):
        raise PatchRecipeError(label + " must have exactly the specified fields")


def _integer(value, maximum, label):
    # Exact types also reject bool, numeric coercions, and custom subclasses.
    if type(value) is not int or not 0 <= value <= maximum:
        raise PatchRecipeError(label + " must be a bounded nonnegative integer")


def _file_metadata(value, label, allow_draft=False):
    _fields(value, {"size", "sha256"}, label)
    size, digest = value["size"], value["sha256"]
    _integer(size, MAX_FILE, label + " size")
    if allow_draft and digest is None:
        return size, digest
    if (type(digest) is not str or len(digest) != 64
            or any(char not in _HEX for char in digest)):
        raise PatchRecipeError(label + " sha256 must be 64 lowercase hex characters")
    return size, digest


def _assemble(before_bytes, edits):
    # Views preserve every untouched byte without first copying each source slice.
    source = memoryview(before_bytes)
    chunks = []
    cursor = 0
    for offset, delete_length, insertion in edits:
        chunks.extend((source[cursor:offset], insertion))
        cursor = offset + delete_length
    chunks.append(source[cursor:])
    return b"".join(chunks)


def _plan(recipe, allow_draft=False):
    """Validate structure and declared bounds without bytes or assembly."""
    _fields(recipe, {"schema", "input", "output", "edits"}, "recipe")
    if type(recipe["schema"]) is not int or recipe["schema"] != 1:
        raise PatchRecipeError("schema must be integer 1")
    input_size, input_hash = _file_metadata(recipe["input"], "input")
    declared_output_size, output_hash = _file_metadata(recipe["output"], "output", allow_draft)
    edits = recipe["edits"]
    if type(edits) is not list or len(edits) > MAX_EDITS:
        raise PatchRecipeError("edits must be a list of at most MAX_EDITS entries")

    # Validate all declared lengths and bounds before decoding any insertion or
    # constructing output. Keep a detached plan rather than re-read recipe edits.
    plan = []
    previous_offset = -1
    previous_end = 0
    inserted_size = 0
    deleted_size = 0
    for edit in edits:
        _fields(edit, {"offset", "delete_length", "insert_base64"}, "edit")
        offset, delete_length = edit["offset"], edit["delete_length"]
        _integer(offset, input_size, "offset")
        _integer(delete_length, input_size - offset, "delete_length")
        if offset <= previous_offset or offset < previous_end:
            raise PatchRecipeError("edits must be sorted, distinct, and nonoverlapping")
        encoded = edit["insert_base64"]
        if (type(encoded) is not str or len(encoded) > _MAX_BASE64
                or len(encoded) % 4):
            raise PatchRecipeError("insert_base64 must be bounded canonical base64")
        padding = 2 if encoded.endswith("==") else 1 if encoded.endswith("=") else 0
        decoded_size = len(encoded) // 4 * 3 - padding
        inserted_size += decoded_size
        if inserted_size > MAX_FILE:
            raise PatchRecipeError("aggregate insertion exceeds MAX_FILE")
        deleted_size += delete_length
        plan.append((offset, delete_length, encoded))
        previous_offset, previous_end = offset, offset + delete_length

    output_size = input_size - deleted_size + inserted_size
    if output_size > MAX_FILE or output_size != declared_output_size:
        raise PatchRecipeError("output size mismatch")
    if not edits and output_hash is not None and input_hash != output_hash:
        raise PatchRecipeError("identity recipe hashes must match")
    return input_size, input_hash, output_size, output_hash, plan


def _decode(plan):
    decoded_edits = []
    for offset, delete_length, encoded in plan:
        try:
            insertion = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise PatchRecipeError("insert_base64 must be bounded canonical base64") from None
        if base64.b64encode(insertion).decode("ascii") != encoded:
            raise PatchRecipeError("insert_base64 must be bounded canonical base64")
        decoded_edits.append((offset, delete_length, insertion))
    return decoded_edits


def _apply(before_bytes, recipe, allow_draft):
    if type(before_bytes) is not bytes or len(before_bytes) > MAX_FILE:
        raise PatchRecipeError("input must be bytes no larger than MAX_FILE")
    input_size, input_hash, output_size, output_hash, plan = _plan(recipe, allow_draft)
    if input_size != len(before_bytes):
        raise PatchRecipeError("input size mismatch")
    if hashlib.sha256(before_bytes).hexdigest() != input_hash:
        raise PatchRecipeError("input hash mismatch")

    result = _assemble(before_bytes, _decode(plan))
    if (len(result) != output_size or
            output_hash is not None and hashlib.sha256(result).hexdigest() != output_hash):
        raise PatchRecipeError("output size or hash mismatch")
    return result


def apply_recipe(before_bytes: bytes, recipe: dict) -> bytes:
    """Return only complete input- and output-hash-verified patched bytes.

    Schema: {"schema": 1, "input": {"size": int, "sha256": str},
             "output": {"size": int, "sha256": str}, "edits": [
                 {"offset": int, "delete_length": int, "insert_base64": str}]}

    Offsets address the original input, strictly increasing and nonoverlapping.
    Bounds are 2 MiB input/output/aggregate insertion and 64 edits. Only exact
    built-in types and canonical padded standard ASCII base64 are accepted.
    No result is assembled until every edit, declared size and input hash passes.
    Draft output hashes are forbidden. No I/O or code execution is performed.
    """
    return _apply(before_bytes, recipe, False)


def preview_recipe(before_bytes: bytes, recipe: dict) -> bytes:
    """Prepare in-memory bytes; only this API permits a null output hash.

    Input bytes, all edit structure and all size bounds remain mandatory.
    Callers must never publish this result without sealing and using apply_recipe.
    A supplied output hash is always enforced, even during preparation.
    """
    return _apply(before_bytes, recipe, True)


def verify_recipe_output(after_bytes: bytes, recipe: dict) -> bytes:
    """Verify already-accepted output and full strict recipe structure.

    The caller must independently prove the current bytes' accepted code chain.
    This does not reconstruct the unavailable input or claim the recipe was
    applied. Every edit, including its canonical base64, is validated first.
    """
    if type(after_bytes) is not bytes or len(after_bytes) > MAX_FILE:
        raise PatchRecipeError("output must be bytes no larger than MAX_FILE")
    _, _, output_size, output_hash, plan = _plan(recipe)
    _decode(plan)
    if len(after_bytes) != output_size or hashlib.sha256(after_bytes).hexdigest() != output_hash:
        raise PatchRecipeError("output size or hash mismatch")
    return after_bytes
