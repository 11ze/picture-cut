package saver

import "golang.org/x/sys/unix"

func moveExclusive(from, to string) error {
	return unix.RenamexNp(from, to, unix.RENAME_EXCL)
}
