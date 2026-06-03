/*
 * Layer 1: Streaming State Machine
 * Incremental parser that processes token-by-token chunks
 * Maintains structural state without requiring complete input
 */

import type { ParserState } from './types'

export interface StreamChunkResult {
  buffer: string
  triggersExtraction: boolean
  inProgress: boolean
}

export class StreamingStateMachine {
  private state: ParserState = {
    buffer: '',
    insideCodeBlock: false,
    braceDepth: 0,
    bracketDepth: 0,
    inString: false,
    escapeNext: false,
    potentialToolStart: false,
  }

  private lastChunkEndsWithJson: boolean = false

  reset(): void {
    this.state = {
      buffer: '',
      insideCodeBlock: false,
      braceDepth: 0,
      bracketDepth: 0,
      inString: false,
      escapeNext: false,
      potentialToolStart: false,
    }
    this.lastChunkEndsWithJson = false
  }

  getState(): ParserState {
    return { ...this.state }
  }

  isInsideStructuredValue(): boolean {
    return this.state.braceDepth > 0 || this.state.bracketDepth > 0
  }

  push(chunk: string): StreamChunkResult {
    this.state.buffer += chunk

    for (let i = 0; i < chunk.length; i++) {
      const char = chunk[i]
      this.processChar(char)
    }

    const triggersExtraction = this.shouldAttemptExtraction()
    const inProgress = this.isInsideStructuredValue() || this.looksLikeReAct(chunk)

    return {
      buffer: this.state.buffer,
      triggersExtraction,
      inProgress,
    }
  }

  private processChar(char: string): void {
    const { inString, escapeNext } = this.state

    if (escapeNext) {
      this.state.escapeNext = false
      return
    }

    if (char === '\\' && inString) {
      this.state.escapeNext = true
      return
    }

    if (!inString) {
      if (char === '"') {
        this.state.inString = true
        return
      }

      if (char === '{') {
        this.state.braceDepth++
        this.state.potentialToolStart = true
        return
      }

      if (char === '}') {
        if (this.state.braceDepth > 0) this.state.braceDepth--
        this.updatePotentialToolStart()
        return
      }

      if (char === '[') {
        this.state.bracketDepth++
        return
      }

      if (char === ']') {
        if (this.state.bracketDepth > 0) this.state.bracketDepth--
        return
      }

      if (char === '`') {
        this.state.insideCodeBlock = !this.state.insideCodeBlock
        return
      }
    } else {
      if (char === '"') {
        this.state.inString = false
        return
      }
    }
  }

  private updatePotentialToolStart(): void {
    const { buffer, braceDepth } = this.state
    if (braceDepth > 0) return

    const trimmed = buffer.trimEnd()
    if (trimmed.length === 0) {
      this.state.potentialToolStart = false
      return
    }

    const lastBlock = this.extractLastBlock(trimmed)
    if (lastBlock) {
      this.state.potentialToolStart = true
    }
  }

  private extractLastBlock(text: string): string | null {
    let depth = 0
    let start = -1

    for (let i = text.length - 1; i >= 0; i--) {
      const char = text[i]
      if (char === '}') {
        if (depth === 0) start = i
        depth++
      } else if (char === '{') {
        depth--
        if (depth === 0 && start !== -1) {
          return text.slice(i, start + 1)
        }
      }
    }

    return null
  }

  private looksLikeReAct(chunk: string): boolean {
    const markers = ['Action:', 'Action Input:', 'Thought:']

    for (const marker of markers) {
      if (chunk.includes(marker)) return true
    }

    return false
  }

  private shouldAttemptExtraction(): boolean {
    const { braceDepth, buffer } = this.state

    if (braceDepth === 0 && buffer.trim().length > 0) {
      const trimmed = buffer.trimEnd()
      return trimmed.endsWith('}') || trimmed.endsWith(']')
    }

    return false
  }

  extractCompleteSpans(): string[] {
    const spans: string[] = []
    const { buffer, braceDepth } = this.state

    if (braceDepth !== 0) return spans

    const trimmed = buffer.trim()
    if (trimmed.length === 0) return spans

    // Extract JSON objects/arrays
    let depth = 0
    let start = -1
    let inString = false
    let escape = false

    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed[i]

      if (escape) {
        escape = false
        continue
      }

      if (char === '\\' && inString) {
        escape = true
        continue
      }

      if (char === '"' && !escape) {
        inString = !inString
        continue
      }

      if (inString) continue

      if (char === '{' || char === '[') {
        if (depth === 0) start = i
        depth++
      } else if (char === '}' || char === ']') {
        depth--
        if (depth === 0 && start !== -1) {
          spans.push(trimmed.slice(start, i + 1))
          start = -1
        }
      }
    }

    // Check for ReAct patterns
    const reactMatch = trimmed.match(/Action:\s*(\w+)\s*\n?Action Input:\s*(\{[\s\S]*\})/) ||
                       trimmed.match(/Action:\s*(\w+)\s*Action Input:\s*(\{[\s\S]*\})/)

    if (reactMatch && !spans.includes(reactMatch[2])) {
      spans.push(reactMatch[2])
    }

    return spans
  }

  hasCompleteContent(): boolean {
    const { braceDepth, buffer } = this.state

    if (braceDepth !== 0) return false

    const trimmed = buffer.trim()
    return trimmed.includes('{') || trimmed.includes('[') ||
           /Action:\s*\w+\s*\n?Action Input:/.test(trimmed)
  }

  getBuffer(): string {
    return this.state.buffer
  }

  setBuffer(buffer: string): void {
    this.state.buffer = buffer
  }
}
