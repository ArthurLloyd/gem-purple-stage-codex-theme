import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Examine the publishable file set. Never print matched personal data or tokens.
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
  .split('\0').filter(file => file && fs.existsSync(file));
const textExtensions = new Set(['.md', '.ts', '.cs', '.ps1', '.vbs', '.cmd', '.json', '.css', '.yml', '.yaml', '.toml', '.txt']);
const findings: string[] = [];
const rules = [
  { name: 'personal Windows path', pattern: /[A-Z]:[\\/](?:Users|Project|Downloads)[\\/]/i },
  { name: 'personal Unix path', pattern: /\/(?:Users|home)\/[^/\s]+\// },
  { name: 'GitHub credential', pattern: /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  { name: 'API credential', pattern: /sk-[A-Za-z0-9_-]{30,}/ },
  { name: 'private key', pattern: new RegExp('-----BEGIN ' + '(?:[A-Z]+ )?PRIVATE KEY-----') },
];
for (const file of files) {
  if (/^(?:fig|audit|backups|debug)\//.test(file) || /(?:^|\/)(?:\.env(?:\..*)?|.*\.(?:log|lnk|bak|tmp))$/.test(file)) {
    findings.push(`${file}: private or generated file in publishable sources`);
  }
  if (textExtensions.has(path.extname(file)) || ['NOTICE', '.gitignore', '.gitattributes'].includes(path.basename(file))) {
    const content = fs.readFileSync(file, 'utf8');
    content.split(/\r?\n/).forEach((line, index) => {
      for (const rule of rules) if (rule.pattern.test(line)) findings.push(`${file}:${index + 1}: ${rule.name}`);
      if (!/LICENSE|NOTICE/i.test(file)) {
        const addresses = line.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
        for (const address of addresses) {
          if (!address.endsWith('@users.noreply.github.com') && !/@(?:example\.(?:com|org)|example\.invalid)$/.test(address)) {
            findings.push(`${file}:${index + 1}: non-placeholder email address`);
          }
        }
      }
    });
  }
  if (/\.(?:png|webp)$/i.test(file)) {
    const data = fs.readFileSync(file);
    if (file.endsWith('.png')) {
      for (let offset = 8; offset + 12 <= data.length;) {
        const size = data.readUInt32BE(offset), kind = data.toString('ascii', offset + 4, offset + 8);
        if (['eXIf', 'tEXt', 'iTXt', 'zTXt'].includes(kind)) findings.push(`${file}: PNG metadata (${kind}) requires review`);
        offset += size + 12;
      }
    } else {
      for (let offset = 12; offset + 8 <= data.length;) {
        const kind = data.toString('ascii', offset, offset + 4), size = data.readUInt32LE(offset + 4);
        if (['EXIF', 'XMP '].includes(kind)) findings.push(`${file}: WebP metadata (${kind.trim()}) requires review`);
        offset += 8 + size + (size % 2);
      }
    }
  }
}
if (findings.length) {
  console.error(findings.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Public-source checks passed for ${files.length} files (paths, common credentials, emails and image metadata).`);
  console.log('Scope: current files only. Review old commits, tags and other refs separately before making a repository public.');
}
