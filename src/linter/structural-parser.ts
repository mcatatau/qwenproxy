/*
 * Layer 2: Structural AST Parser (Tolerant)
 * Builds partial AST from JSON-like structures without strict parsing
 */

import type { PartialASTNode, ToolCallSource } from './types'

export interface StructuralParseResult {
  ast: PartialASTNode | null
  confidence: number
  errors: string[]
  sourceHint: ToolCallSource
}

export class StructuralParser {
  private pos = 0
  private text = ''
  private errors: string[] = []

  parse(text: string, sourceHint: ToolCallSource = 'unknown'): StructuralParseResult {
    this.pos = 0
    this.text = text.trim()
    this.errors = []

    if (this.text.length === 0) {
      return { ast: null, confidence: 0, errors: ['Empty input'], sourceHint }
    }

    const nodes: PartialASTNode[] = []

    while (this.pos < this.text.length) {
      this.skipWhitespace()
      if (this.pos >= this.text.length) break
      const node = this.parseValue()
      if (node) nodes.push(node)
    }

    if (nodes.length === 0) {
      return { ast: null, confidence: 0, errors: ['No parseable content'], sourceHint }
    }

    const root: PartialASTNode = {
      type: 'object',
      raw: this.text,
      confidence: this.calculateConfidence(nodes),
    }
    if (nodes.length === 1 && nodes[0].type === 'object' && nodes[0].value !== undefined) {
      root.value = nodes[0].value
      root.children = nodes[0].children
    } else {
      root.children = nodes
    }

    return { ast: root, confidence: root.confidence, errors: this.errors, sourceHint }
  }

  private parseValue(): PartialASTNode | undefined {
    const char = this.peek()
    if (char === '{') return this.parseObject()
    if (char === '[') return this.parseArray()
    if (char === '"' || char === "'") return this.parseString()
    if (this.isNull(char)) return this.parseNull()
    if (this.isBoolean(char)) return this.parseBoolean()
    if (this.isNumberStart(char)) return this.parseNumber()
    if (this.isUnquotedKey(char)) return this.parseUnquotedValue()
    if (this.isReActAction(char)) return this.parseReActBlock()
    return undefined
  }

  private parseObject(): PartialASTNode {
    const start = this.pos
    this.expect('{')
    const children: PartialASTNode[] = []

    while (this.pos < this.text.length) {
      this.skipWhitespace()
      if (this.peek() === '}') { this.pos++; break }

      const key = this.parseKey()
      if (!key) { this.pos++; this.errors.push(`Expected key at position ${this.pos}`); continue }

      this.skipWhitespace()
      this.expectOptional(':')
      this.skipWhitespace()

      let value: PartialASTNode | undefined
      const ch = this.peek()
      if (ch === '"' || ch === "'") value = this.parseString()
      else if (ch === '{') value = this.parseObject()
      else if (ch === '[') value = this.parseArray()
      else value = this.parseScalar()

      if (value) {
        children.push({
          type: 'object',
          value: value.value,
          raw: this.text.slice(start, this.pos),
          confidence: 1,
          children: [key, value],
        })
      }

      this.skipWhitespace()
      if (this.expectOptional(',')) {
        this.skipWhitespace()
        if (this.peek() === '}') break
      }
    }

    const value: Record<string, unknown> = {}
    for (const child of children) {
      if (child.children && child.children.length >= 2) {
        const key = child.children[0].value
        const val = child.children[1].value
        if (key !== undefined) value[key as string] = val
      }
    }

    return {
      type: 'object',
      value,
      raw: this.text.slice(start, this.pos),
      confidence: this.calculateObjectConfidence(children),
      children,
    }
  }

  private parseArray(): PartialASTNode {
    const start = this.pos
    this.expect('[')
    const children: PartialASTNode[] = []

    while (this.pos < this.text.length) {
      this.skipWhitespace()
      if (this.peek() === ']') { this.pos++; break }
      const value = this.parseValue()
      if (value) children.push(value)
      this.skipWhitespace()
      this.expectOptional(',')
    }

    return {
      type: 'array',
      raw: this.text.slice(start, this.pos),
      confidence: children.length > 0 ? 0.9 : 0.5,
      children,
    }
  }

  private parseString(): PartialASTNode {
    const start = this.pos
    const quote = this.peek()
    this.expect(quote as '"' | "'")
    let value = ''
    try {
      value = this.readStringContent(quote)
    } catch {
      this.errors.push(`Unterminated string at position ${start}`)
      const content = this.text.slice(start + 1)
      const idx = content.split('').findIndex((c, i) => c === quote && (i === 0 || content[i - 1] !== '\\'))
      value = idx === -1 ? content : content.slice(0, idx)
      this.pos = this.text.length
    }
    return { type: 'string', value, raw: this.text.slice(start, this.pos), confidence: 0.95 }
  }

  private readStringContent(quote: string): string {
    let value = ''
    while (this.pos < this.text.length) {
      const char = this.text[this.pos++]
      if (char === '\\' && this.pos < this.text.length) {
        const next = this.text[this.pos++]
        value += this.resolveEscapeSequence(char, next)
        continue
      }
      if (char === quote) break
      value += char
    }
    return value
  }

  private resolveEscapeSequence(_backslash: string, char: string): string {
    const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', "'": "'", '\\': '\\', '0': '\0' }
    return map[char] ?? _backslash + char
  }

  private parseKey(): PartialASTNode | undefined {
    const start = this.pos
    if (this.peek() === '"' || this.peek() === "'") {
      const key = this.parseString()
      return { type: 'string', value: key.value, raw: key.raw, confidence: 1 }
    }

    let key = ''
    while (this.pos < this.text.length) {
      const c = this.text[this.pos]
      if (/[a-zA-Z0-9_\-]/.test(c)) { key += c; this.pos++ }
      else break
    }

    if (key.length === 0) { this.pos = start; return undefined }
  }

  private parseScalar(): PartialASTNode | undefined {
    const start = this.pos
    let value = ''
    while (this.pos < this.text.length) {
      const c = this.text[this.pos]
      if (c === ',' || c === '}' || c === ']' || c === '\n') break
      value += c
      this.pos++
    }
    value = value.trim()

    if (value === 'true') return { type: 'boolean', value: true, raw: value, confidence: 1 }
    if (value === 'false') return { type: 'boolean', value: false, raw: value, confidence: 1 }
    if (value === 'null' || value === 'undefined') return { type: 'null', value: null, raw: value, confidence: 0.9 }
    const num = Number(value)
    if (!isNaN(num) && isFinite(num)) return { type: 'number', value: num, raw: value, confidence: 0.9 }
    if (value.startsWith('"') && value.endsWith('"')) return { type: 'string', value: value.slice(1, -1), raw: value, confidence: 0.85 }
    if (value.startsWith("'") && value.endsWith("'")) return { type: 'string', value: value.slice(1, -1), raw: value, confidence: 0.8 }
    return { type: 'unknown', value, raw: value, confidence: 0.3 }
  }

  private parseUnquotedValue(): PartialASTNode | undefined {
    const start = this.pos
    let value = ''
    while (this.pos < this.text.length) {
      const c = this.text[this.pos]
      if (/[a-zA-Z0-9_\- ]/.test(c)) { value += c; this.pos++ }
      else break
    }
    if (value.length === 0) return undefined
    return { type: 'unknown', value: value.trim(), raw: value, confidence: 0.5 }
  }

  private parseNull(): PartialASTNode | undefined {
    if (this.text.slice(this.pos, this.pos + 4) === 'null') {
      this.pos += 4
      return { type: 'null', value: null, raw: 'null', confidence: 1 }
    }
    return undefined
  }

  private parseBoolean(): PartialASTNode | undefined {
    if (this.text.slice(this.pos, this.pos + 4) === 'true') {
      this.pos += 4
      return { type: 'boolean', value: true, raw: 'true', confidence: 1 }
    }
    if (this.text.slice(this.pos, this.pos + 5) === 'false') {
      this.pos += 5
      return { type: 'boolean', value: false, raw: 'false', confidence: 1 }
    }
    return undefined
  }

  private parseNumber(): PartialASTNode | undefined {
    const start = this.pos
    let value = ''
    while (this.pos < this.text.length) {
      const c = this.text[this.pos]
      if (/[0-9.\-eE+]/.test(c)) { value += c; this.pos++ }
      else break
    }
    if (value.length === 0) return undefined
    const num = Number(value)
    if (!isNaN(num) && isFinite(num)) return { type: 'number', value: num, raw: value, confidence: 0.9 }
    return { type: 'unknown', value, raw: value, confidence: 0.3 }
  }

  private parseReActBlock(): PartialASTNode | undefined {
    const start = this.pos
    let action = ''
    let input = ''

    const actionMatch = this.text.slice(this.pos).match(/^Action:\s*(\w+)/i)
    if (!actionMatch) return undefined
    action = actionMatch[1]
    this.pos += actionMatch[0].length
    this.skipWhitespace()

    const inputMatch = this.text.slice(this.pos).match(/^Action Input:\s*(\{[\s\S]*)/i)
    if (inputMatch) {
      input = inputMatch[1].trim()
      this.pos += inputMatch[0].length
    }

    return { type: 'object', value: { action, input }, raw: this.text.slice(start, this.pos), confidence: 0.85 }
  }

  private isReActAction(char: string): boolean {
    return /^Action:|^thought|^Observation|^Final Answer/i.test(this.text.slice(this.pos))
  }
  private isNull(char: string): boolean { return this.text.slice(this.pos, this.pos + 4) === 'null' }
  private isBoolean(char: string): boolean {
    return this.text.slice(this.pos, this.pos + 4) === 'true' || this.text.slice(this.pos, this.pos + 5) === 'false'
  }
  private isNumberStart(char: string): boolean { return /[0-9.\-]/.test(char) }
  private isUnquotedKey(char: string): boolean { return /[a-zA-Z_]/.test(char) && !this.isNull(char) && !this.isReActAction(char) }

  private skipWhitespace(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos++
  }
  private peek(): string { return this.text[this.pos] ?? '' }
  private expect(char: string): boolean {
    if (this.peek() === char) { this.pos++; return true }
    this.errors.push(`Expected '${char}' at position ${this.pos}, got '${this.peek()}'`)
    return false
  }
  private expectOptional(char: string): boolean {
    if (this.peek() === char) { this.pos++; return true }
    return false
  }

  private calculateConfidence(nodes: PartialASTNode[]): number {
    if (nodes.length === 0) return 0
    const avg = nodes.reduce((a, n) => a + n.confidence, 0) / nodes.length
    return Math.max(0, Math.min(1, avg - Math.min(this.errors.length * 0.1, 0.5)))
  }

  private calculateObjectConfidence(children: PartialASTNode[]): number {
    if (children.length === 0) return 0.1
    let confidence = 0.7
    if (children.some(c => c.children && c.children[0]?.type === 'string')) confidence += 0.2
    if (this.errors.length === 0) confidence += 0.1
    if (children.length >= 2) confidence += 0.05
    return Math.min(0.99, confidence)
  }

  static extractJsonFromText(text: string): string[] {
    const results: string[] = []
    let depth = 0, start = -1, inString = false, escape = false

    for (let i = 0; i < text.length; i++) {
      const char = text[i]
      if (escape) { escape = false; continue }
      if (char === '\\' && inString) { escape = true; continue }
      if (char === '"' && !escape) { inString = !inString; continue }
      if (inString) continue

      if (char === '{' || char === '[') {
        if (depth === 0) start = i
        depth++
      } else if (char === '}' || char === ']') {
        depth--
        if (depth === 0 && start !== -1) { results.push(text.slice(start, i + 1)); start = -1 }
      }
    }

    return results
  }
}
