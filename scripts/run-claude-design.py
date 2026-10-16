#!/usr/bin/env python3
"""Run the project's Claude design role through the existing Devin gateway."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parents[1]
MAX_BRIEF_CHARS = 18000


def request_stop(_signum: int, _frame: object) -> None:
    raise KeyboardInterrupt


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--brief', required=True, type=Path, help='UTF-8 design brief')
    parser.add_argument('--output', required=True, type=Path, help='New Markdown handoff file')
    parser.add_argument('--image', action='append', default=[], type=Path, help='Optional local reference image')
    parser.add_argument('--timeout', type=int, default=240, help='Process timeout in seconds; not a token budget')
    parser.add_argument('--dry-run', action='store_true', help='Validate inputs without calling Claude')
    args = parser.parse_args()
    role = tomllib.loads((ROOT / '.codex/external-agents/designer.toml').read_text(encoding='utf-8'))
    rules_path = ROOT / 'docs/design/design-rules.md'
    if not rules_path.is_file():
        parser.error('required design rules are missing: docs/design/design-rules.md')
    rules = rules_path.read_text(encoding='utf-8')
    if not rules.strip():
        parser.error('required design rules must not be empty')
    if role['model'] != 'devin/claude-opus-5-5' or role.get('model_provider') != 'magpie' or role.get('transport') != 'codex_exec':
        parser.error('designer model has changed; review this launcher before using it')
    if not args.brief.is_file():
        parser.error('brief file does not exist')
    brief = args.brief.read_text(encoding='utf-8')
    if not brief.strip() or len(brief) > MAX_BRIEF_CHARS:
        parser.error(f'brief must contain 1–{MAX_BRIEF_CHARS} characters; summarize the task first')
    if args.output.exists() or args.output.with_name(args.output.name + '.run.json').exists():
        parser.error('output already exists; use a new filename for each design round')
    if not 1 <= args.timeout <= 900:
        parser.error('timeout must be between 1 and 900 seconds')
    if any(not p.is_file() for p in args.image):
        parser.error('a reference image does not exist')
    if len(args.image) > 3:
        parser.error('use at most 3 focused reference images')
    cli = shutil.which('codex')
    if not cli:
        parser.error('codex CLI is unavailable')
    user_config = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'config.toml'
    if not user_config.is_file() or 'magpie' not in tomllib.loads(user_config.read_text()).get('model_providers', {}):
        parser.error('existing user-level magpie provider is required; no credentials are installed by this script')
    plan = {'model': role['model'], 'provider': 'magpie (existing configuration)',
            'reasoning_effort': role['model_reasoning_effort'], 'brief_chars': len(brief),
            'design_rules': str(rules_path.relative_to(ROOT)), 'design_rules_chars': len(rules),
            'image_count': len(args.image), 'output': str(args.output.resolve()),
            'timeout_seconds': args.timeout, 'automatic_retries': 0, 'calls_claude': not args.dry_run}
    print(json.dumps(plan, ensure_ascii=False), flush=True)
    if args.dry_run:
        return 0
    prompt = role['developer_instructions'] + '\n\n项目通用设计规则（必须遵循，用户最新要求优先）：\n' + rules + '\n\n本次设计 Brief：\n' + brief + '\n\n只返回设计交付 Markdown。禁止调用任何工具或读写文件；不要自述模型型号。'
    with tempfile.TemporaryDirectory(prefix='imtoken-fans-design-') as workdir:
        cmd = [cli, 'exec', '--ephemeral', '--skip-git-repo-check', '-C', workdir,
               '-m', role['model'], '-s', 'read-only', '-c', f'model_provider="{role["model_provider"]}"',
               '-c', f'model_reasoning_effort="{role["model_reasoning_effort"]}"',
               '-c', 'model_providers.magpie.request_max_retries=0',
               '-c', 'model_providers.magpie.stream_max_retries=0',
               '-c', 'agents.enabled=false', '-c', 'features.apps=false',
               '-c', 'features.plugins=false', '-c', 'features.memories=false',
               '-c', 'features.shell_tool=false', '-c', 'web_search="disabled"',
               '-c', 'skills.include_instructions=false', '-c', 'skills.bundled.enabled=false', '--json']
        for ref in args.image:
            cmd.extend(['--image', str(ref.resolve())])
        cmd.append('-')
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, start_new_session=True)
        previous_stop_handler = signal.signal(signal.SIGTERM, request_stop)
        try:
            stdout, _stderr = proc.communicate(input=prompt, timeout=args.timeout)
        except (subprocess.TimeoutExpired, KeyboardInterrupt) as exc:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                proc.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.communicate()
            interrupted = isinstance(exc, KeyboardInterrupt)
            reason = 'was interrupted' if interrupted else 'timed out'
            print(f'Claude design process {reason}; no retry or model fallback was started.', file=sys.stderr)
            return 130 if interrupted else 1
        finally:
            signal.signal(signal.SIGTERM, previous_stop_handler)
    messages, errors, usage = [], [], None
    completed = False
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = event.get('type')
        if kind == 'item.completed' and event.get('item', {}).get('type') == 'agent_message':
            messages.append(event['item'].get('text', ''))
        elif kind in ('error', 'turn.failed'):
            errors.append(event)
        elif kind == 'turn.completed':
            completed, usage = True, event.get('usage')
    if proc.returncode != 0 or not completed or not any(message.strip() for message in messages):
        error_text = json.dumps(errors).lower()
        if 'region' in error_text or '403' in error_text:
            cause = 'provider access or region restriction'
        elif '401' in error_text or 'authentication' in error_text:
            cause = 'provider authentication failure'
        elif 'not supported' in error_text:
            cause = 'model or provider unsupported'
        else:
            cause = 'gateway/model request failed or no completed answer'
        print(f'Claude design failed: {cause}. No retry, model switch, or handoff file was created.', file=sys.stderr)
        return 1
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation also prevents a concurrent task from being overwritten.
    try:
        with args.output.open('x', encoding='utf-8') as file:
            file.write('\n\n'.join(messages).rstrip() + '\n')
    except FileExistsError:
        print('Output was created by another task; answer was not overwritten.', file=sys.stderr)
        return 1
    report = {**plan, 'exit_code': proc.returncode, 'completed': completed, 'usage': usage,
              'routing_evidence': 'requested provider/model accepted; provider internal routing not inspected'}
    with args.output.with_name(args.output.name + '.run.json').open('x', encoding='utf-8') as file:
        json.dump(report, file, ensure_ascii=False, indent=2)
        file.write('\n')
    print(json.dumps({'completed': True, 'output': str(args.output.resolve()), 'usage': usage}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
