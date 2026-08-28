// Package obs is the process-wide structured logger.
package obs

import (
	"log/slog"
	"os"
	"sync"
)

var once sync.Once

func Init() {
	once.Do(func() {
		h := slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})
		slog.SetDefault(slog.New(h))
	})
}
