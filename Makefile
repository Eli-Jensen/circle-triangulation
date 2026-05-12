.PHONY: serve stop open

PORT ?= 8080

# Start the local dev server
serve:
	@echo "Starting server at http://localhost:$(PORT)"
	@echo "Press Ctrl+C to stop"
	python3 -m http.server $(PORT)

# Start in the background
serve-bg:
	@echo "Starting server in background at http://localhost:$(PORT)"
	@python3 -m http.server $(PORT) &>/dev/null &
	@echo "PID: $$!"

# Stop any background server on this port
stop:
	@lsof -ti :$(PORT) | xargs kill 2>/dev/null && echo "Server stopped" || echo "No server running on port $(PORT)"

# Open in default browser
open:
	open http://localhost:$(PORT)

# Start server and open browser
dev: serve-bg
	@sleep 0.5
	@open http://localhost:$(PORT)
	@echo "Dev server running. Use 'make stop' to shut down."
