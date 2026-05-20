export class LineCursor {
  constructor(lines) {
    this.lines = lines;
    this.index = 0;
  }

  peek(offset = 0) {
    const i = this.index + offset;
    return i >= 0 && i < this.lines.length ? this.lines[i] : null;
  }

  next() {
    if (this.index >= this.lines.length) return null;
    return this.lines[this.index++];
  }

  eof() {
    return this.index >= this.lines.length;
  }

  lineNumber() {
    return this.index + 1;
  }
}
