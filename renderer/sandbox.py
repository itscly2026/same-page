"""Deny network and cross-process inspection in the disposable Linux PDF parser."""
import ctypes
import errno
import sys


def isolate():
    if sys.platform != "linux":
        return  # macOS fixtures are rendering proof, not Linux isolation proof.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(4, 0, 0, 0, 0) != 0:  # PR_SET_DUMPABLE
        raise RuntimeError("sandbox")
    lib = ctypes.CDLL("libseccomp.so.2", use_errno=True)
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    lib.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    ctx = lib.seccomp_init(0x7FFF0000)  # SCMP_ACT_ALLOW
    if not ctx:
        raise RuntimeError("sandbox")
    try:
        for name in (b"socket", b"socketpair", b"connect", b"ptrace", b"process_vm_readv", b"process_vm_writev"):
            call = lib.seccomp_syscall_resolve_name(name)
            if call < 0 or lib.seccomp_rule_add(ctx, 0x00050000 | errno.EPERM, call, 0) != 0:
                raise RuntimeError("sandbox")
        if lib.seccomp_load(ctx) != 0:
            raise RuntimeError("sandbox")
    finally:
        lib.seccomp_release(ctx)
