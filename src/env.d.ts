/// <reference types="vite-plugin-pwa/client" />

/** The build id Vite injects (shared/clientVersion.ts); the server compares it with its minimum. */
declare const __CODEDUCKY_BUILD__: string

interface LaunchParams {
  readonly targetURL?: string
}

interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void
}

interface Window {
  readonly launchQueue?: LaunchQueue
}

interface WindowControlsOverlay extends EventTarget {
  readonly visible: boolean
}

interface Navigator {
  readonly windowControlsOverlay?: WindowControlsOverlay
}
