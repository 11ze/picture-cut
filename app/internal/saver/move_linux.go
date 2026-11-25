package saver

import (
	"os"

	"golang.org/x/sys/unix"
)

func moveExclusive(from, to string) error {
	return publishLinux(from, to, func(from, to string) error {
		return unix.Renameat2(unix.AT_FDCWD, from, unix.AT_FDCWD, to, unix.RENAME_NOREPLACE)
	})
}

func publishLinux(from, to string, rename func(string, string) error) error {
	switch err := rename(from, to); err {
	case unix.ENOSYS, unix.EINVAL, unix.EOPNOTSUPP:
		// NFS and some other filesystems reject rename flags. A hard link
		// still publishes the completed file without replacing an existing one.
		return os.Link(from, to)
	default:
		return err
	}
}
