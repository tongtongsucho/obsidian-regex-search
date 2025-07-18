import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, MarkdownView } from 'obsidian';

interface RegexSearchSettings {
	defaultPattern: string;
	caseSensitive: boolean;
	multiline: boolean;
	maxResultsPerFile: number;
	includeHiddenFiles: boolean;
	fileExtensions: string[];
}

const DEFAULT_SETTINGS: RegexSearchSettings = {
	defaultPattern: '',
	caseSensitive: false,
	multiline: false,
	maxResultsPerFile: 50,
	includeHiddenFiles: false,
	fileExtensions: ['md', 'txt', 'json', 'js', 'ts', 'css', 'html']
};

interface SearchMatch {
	file: TFile;
	line: number;
	column: number;
	match: string;
	context: string;
}

interface SearchResult {
	file: TFile;
	matches: SearchMatch[];
	totalMatches: number;
}

export default class RegexSearchPlugin extends Plugin {
	settings: RegexSearchSettings;

	async onload() {
		await this.loadSettings();

		// 添加搜索命令
		this.addCommand({
			id: 'open-regex-search',
			name: '打开正则表达式搜索',
			callback: () => {
				new RegexSearchModal(this.app, this).open();
			}
		});

		// 添加当前文件搜索命令
		this.addCommand({
			id: 'regex-search-current-file',
			name: '在当前文件中搜索',
			callback: () => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile) {
					new RegexSearchModal(this.app, this, activeFile).open();
				} else {
					new Notice('没有打开的文件');
				}
			}
		});

		// 添加设置选项卡
		this.addSettingTab(new RegexSearchSettingTab(this.app, this));

		// 添加状态栏项目
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Regex Search');
	}

	onunload() {
		// 清理工作
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// 核心搜索方法
	async searchInFile(file: TFile, pattern: string, flags: string): Promise<SearchResult> {
		const content = await this.app.vault.read(file);
		const regex = new RegExp(pattern, flags);
		const matches: SearchMatch[] = [];
		
		const lines = content.split('\n');
		
		for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
			const line = lines[lineIndex];
			let match: RegExpMatchArray | null;
			
			// 重置正则表达式的 lastIndex
			regex.lastIndex = 0;
			
			while ((match = regex.exec(line)) !== null) {
				if (matches.length >= this.settings.maxResultsPerFile) {
					break;
				}
				
				// 获取上下文（前后各一行）
				const contextLines = [];
				if (lineIndex > 0) contextLines.push(lines[lineIndex - 1]);
				contextLines.push(line);
				if (lineIndex < lines.length - 1) contextLines.push(lines[lineIndex + 1]);
				
				matches.push({
					file: file,
					line: lineIndex + 1,
					column: match.index + 1,
					match: match[0],
					context: contextLines.join('\n')
				});
				
				// 如果不是全局搜索，停止
				if (!flags.includes('g')) {
					break;
				}
			}
			
			if (matches.length >= this.settings.maxResultsPerFile) {
				break;
			}
		}
		
		return {
			file: file,
			matches: matches,
			totalMatches: matches.length
		};
	}

	// 跨文件搜索方法
	async searchInVault(pattern: string, flags: string): Promise<SearchResult[]> {
		const files = this.app.vault.getFiles();
		const results: SearchResult[] = [];
		
		for (const file of files) {
			// 检查文件扩展名
			const extension = file.extension;
			if (!this.settings.fileExtensions.includes(extension)) {
				continue;
			}
			
			// 检查是否包含隐藏文件
			if (!this.settings.includeHiddenFiles && file.name.startsWith('.')) {
				continue;
			}
			
			try {
				const result = await this.searchInFile(file, pattern, flags);
				if (result.matches.length > 0) {
					results.push(result);
				}
			} catch (error) {
				console.error(`搜索文件 ${file.path} 时出错:`, error);
			}
		}
		
		return results;
	}

	// 构建正则表达式标志
	buildRegexFlags(): string {
		let flags = '';
		if (!this.settings.caseSensitive) flags += 'i';
		if (this.settings.multiline) flags += 'm';
		flags += 'g'; // 总是使用全局搜索
		return flags;
	}
}

class RegexSearchModal extends Modal {
	plugin: RegexSearchPlugin;
	currentFile: TFile | null;
	searchResults: SearchResult[] = [];

	constructor(app: App, plugin: RegexSearchPlugin, currentFile?: TFile) {
		super(app);
		this.plugin = plugin;
		this.currentFile = currentFile || null;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: this.currentFile ? `在 ${this.currentFile.name} 中搜索` : '正则表达式搜索' });

		// 创建搜索表单
		const searchContainer = contentEl.createDiv({ cls: 'regex-search-container' });
		
		// 正则表达式输入
		const patternContainer = searchContainer.createDiv({ cls: 'regex-pattern-container' });
		patternContainer.createEl('label', { text: '正则表达式模式：' });
		const patternInput = patternContainer.createEl('input', { 
			type: 'text',
			placeholder: '输入正则表达式...',
			value: this.plugin.settings.defaultPattern
		});
		patternInput.focus();

		// 搜索选项
		const optionsContainer = searchContainer.createDiv({ cls: 'regex-options-container' });
		
		const caseSensitiveToggle = this.createToggle(optionsContainer, '区分大小写', this.plugin.settings.caseSensitive);
		const multilineToggle = this.createToggle(optionsContainer, '多行模式', this.plugin.settings.multiline);

		// 搜索按钮
		const buttonContainer = searchContainer.createDiv({ cls: 'regex-button-container' });
		const searchButton = buttonContainer.createEl('button', { text: '搜索' });
		const clearButton = buttonContainer.createEl('button', { text: '清空结果' });

		// 结果容器
		const resultsContainer = contentEl.createDiv({ cls: 'regex-results-container' });

		// 搜索函数
		const performSearch = async () => {
			const pattern = patternInput.value.trim();
			if (!pattern) {
				new Notice('请输入正则表达式模式');
				return;
			}

			try {
				// 构建标志
				let flags = '';
				if (!caseSensitiveToggle.checked) flags += 'i';
				if (multilineToggle.checked) flags += 'm';
				flags += 'g';

				// 测试正则表达式
				new RegExp(pattern, flags);

				// 执行搜索
				resultsContainer.empty();
				resultsContainer.createEl('div', { text: '搜索中...', cls: 'regex-loading' });

				let results: SearchResult[];
				if (this.currentFile) {
					const result = await this.plugin.searchInFile(this.currentFile, pattern, flags);
					results = result.matches.length > 0 ? [result] : [];
				} else {
					results = await this.plugin.searchInVault(pattern, flags);
				}

				this.displayResults(results, resultsContainer);
			} catch (error) {
				new Notice('正则表达式语法错误：' + error.message);
			}
		};

		// 绑定事件
		searchButton.addEventListener('click', performSearch);
		patternInput.addEventListener('keypress', (e) => {
			if (e.key === 'Enter') {
				performSearch();
			}
		});

		clearButton.addEventListener('click', () => {
			resultsContainer.empty();
			this.searchResults = [];
		});

		// 添加样式
		this.addStyles();
	}

	private createToggle(container: HTMLElement, label: string, defaultValue: boolean): HTMLInputElement {
		const toggleContainer = container.createDiv({ cls: 'regex-toggle-container' });
		const checkbox = toggleContainer.createEl('input', { type: 'checkbox' });
		checkbox.checked = defaultValue;
		toggleContainer.createEl('label', { text: label });
		return checkbox;
	}

	private displayResults(results: SearchResult[], container: HTMLElement) {
		container.empty();

		if (results.length === 0) {
			container.createEl('div', { text: '未找到匹配项', cls: 'regex-no-results' });
			return;
		}

		// 统计信息
		const totalMatches = results.reduce((sum, result) => sum + result.totalMatches, 0);
		const statsEl = container.createEl('div', { cls: 'regex-stats' });
		statsEl.createEl('span', { text: `找到 ${totalMatches} 个匹配项，分布在 ${results.length} 个文件中` });

		// 显示结果
		results.forEach((result) => {
			const fileContainer = container.createDiv({ cls: 'regex-file-result' });
			
			// 文件标题
			const fileTitle = fileContainer.createEl('div', { cls: 'regex-file-title' });
			fileTitle.createEl('strong', { text: result.file.name });
			fileTitle.createEl('span', { text: ` (${result.totalMatches} 个匹配项)` });

			// 匹配项
			const matchesContainer = fileContainer.createDiv({ cls: 'regex-matches-container' });
			result.matches.forEach((match) => {
				const matchEl = matchesContainer.createDiv({ cls: 'regex-match' });
				
				// 位置信息
				const locationEl = matchEl.createEl('div', { cls: 'regex-match-location' });
				locationEl.createEl('span', { text: `第 ${match.line} 行` });
				
				// 匹配内容
				const contentEl = matchEl.createEl('div', { cls: 'regex-match-content' });
				const contextLines = match.context.split('\n');
				contextLines.forEach((line, lineIndex) => {
					const lineEl = contentEl.createEl('div', { cls: 'regex-context-line' });
					if (lineIndex === Math.floor(contextLines.length / 2)) {
						// 高亮匹配行
						lineEl.addClass('regex-match-line');
						const beforeMatch = line.substring(0, match.column - 1);
						const matchText = match.match;
						const afterMatch = line.substring(match.column - 1 + matchText.length);
						
						lineEl.createEl('span', { text: beforeMatch });
						lineEl.createEl('span', { text: matchText, cls: 'regex-highlight' });
						lineEl.createEl('span', { text: afterMatch });
					} else {
						lineEl.createEl('span', { text: line });
					}
				});

				// 点击跳转
				matchEl.addEventListener('click', async () => {
					// 添加加载状态
					matchEl.addClass('loading');
					
					// 关闭搜索模态窗口
					this.close();
					
					// 打开文件并跳转到具体位置
					const leaf = this.app.workspace.getLeaf();
					await leaf.openFile(result.file);
					
					// 等待文件加载完成
					setTimeout(() => {
						// 获取编辑器实例
						const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
						if (activeView && activeView.editor) {
							const editor = activeView.editor;
							
							// 跳转到指定行
							const line = match.line - 1; // 编辑器行号从0开始
							const column = match.column - 1; // 编辑器列号从0开始
							
							// 设置光标位置
							editor.setCursor(line, column);
							
							// 滚动到视图中心
							editor.scrollIntoView({
								from: { line: line, ch: 0 },
								to: { line: line, ch: editor.getLine(line).length }
							}, true);
							
							// 高亮显示匹配的文本
							this.highlightMatch(editor, match, result.file.path);
						}
					}, 100);
				});
			});
		});

		this.searchResults = results;
	}

	private addStyles() {
		const style = document.createElement('style');
		style.textContent = `
			.regex-search-container {
				margin-bottom: 20px;
			}
			
			.regex-pattern-container {
				margin-bottom: 15px;
			}
			
			.regex-pattern-container label {
				display: block;
				margin-bottom: 5px;
				font-weight: bold;
			}
			
			.regex-pattern-container input {
				width: 100%;
				padding: 8px;
				border: 1px solid var(--background-modifier-border);
				border-radius: 4px;
				font-family: monospace;
			}
			
			.regex-options-container {
				display: flex;
				flex-wrap: wrap;
				gap: 15px;
				margin-bottom: 15px;
			}
			
			.regex-toggle-container {
				display: flex;
				align-items: center;
				gap: 5px;
			}
			
			.regex-button-container {
				display: flex;
				gap: 10px;
				margin-bottom: 20px;
			}
			
			.regex-button-container button {
				padding: 8px 16px;
				border: 1px solid var(--background-modifier-border);
				border-radius: 4px;
				background: var(--background-primary);
				color: var(--text-normal);
				cursor: pointer;
			}
			
			.regex-button-container button:hover {
				background: var(--background-modifier-hover);
			}
			
			.regex-results-container {
				max-height: 400px;
				overflow-y: auto;
				border: 1px solid var(--background-modifier-border);
				border-radius: 4px;
				padding: 10px;
			}
			
			.regex-loading {
				text-align: center;
				padding: 20px;
				color: var(--text-muted);
			}
			
			.regex-no-results {
				text-align: center;
				padding: 20px;
				color: var(--text-muted);
			}
			
			.regex-stats {
				margin-bottom: 15px;
				padding: 10px;
				background: var(--background-secondary);
				border-radius: 4px;
				font-weight: bold;
			}
			
			.regex-file-result {
				margin-bottom: 20px;
				border: 1px solid var(--background-modifier-border);
				border-radius: 4px;
				padding: 10px;
			}
			
			.regex-file-title {
				margin-bottom: 10px;
				padding-bottom: 5px;
				border-bottom: 1px solid var(--background-modifier-border);
			}
			
			.regex-match {
				margin-bottom: 15px;
				padding: 10px;
				background: var(--background-secondary);
				border-radius: 4px;
				cursor: pointer;
			}
			
			.regex-match:hover {
				background: var(--background-modifier-hover);
			}
			
			.regex-match-location {
				font-size: 0.9em;
				color: var(--text-muted);
				margin-bottom: 5px;
			}
			
			.regex-match-content {
				font-family: monospace;
				font-size: 0.9em;
			}
			
			.regex-context-line {
				margin: 2px 0;
			}
			
			.regex-match-line {
				font-weight: bold;
			}
			
			.regex-highlight {
				background: var(--text-highlight-bg);
				color: var(--text-on-accent);
				padding: 2px 4px;
				border-radius: 2px;
			}
		`;
		document.head.appendChild(style);
	}

	// 高亮匹配的文本
	private highlightMatch(editor: any, match: SearchMatch, filePath: string) {
		try {
			// 获取匹配文本的位置
			const line = match.line - 1;
			const column = match.column - 1;
			const matchLength = match.match.length;
			
			// 选择匹配的文本
			editor.setSelection(
				{ line: line, ch: column },
				{ line: line, ch: column + matchLength }
			);
			
			// 3秒后清除选择
			setTimeout(() => {
				try {
					editor.setCursor(line, column);
				} catch (error) {
					// 忽略错误，可能是编辑器已关闭
				}
			}, 3000);
		} catch (error) {
			console.error('高亮匹配文本时出错:', error);
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class RegexSearchSettingTab extends PluginSettingTab {
	plugin: RegexSearchPlugin;

	constructor(app: App, plugin: RegexSearchPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl('h2', { text: '正则表达式搜索设置' });

		new Setting(containerEl)
			.setName('默认搜索模式')
			.setDesc('打开搜索时的默认正则表达式模式')
			.addText(text => text
				.setPlaceholder('输入默认正则表达式...')
				.setValue(this.plugin.settings.defaultPattern)
				.onChange(async (value) => {
					this.plugin.settings.defaultPattern = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('区分大小写')
			.setDesc('默认启用区分大小写搜索')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.caseSensitive)
				.onChange(async (value) => {
					this.plugin.settings.caseSensitive = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('多行模式')
			.setDesc('默认启用多行模式（^ 和 $ 匹配行首行尾）')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.multiline)
				.onChange(async (value) => {
					this.plugin.settings.multiline = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('每个文件最大结果数')
			.setDesc('限制每个文件显示的最大搜索结果数量')
			.addText(text => text
				.setPlaceholder('50')
				.setValue(this.plugin.settings.maxResultsPerFile.toString())
				.onChange(async (value) => {
					const num = parseInt(value);
					if (!isNaN(num) && num > 0) {
						this.plugin.settings.maxResultsPerFile = num;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('包含隐藏文件')
			.setDesc('在搜索中包含隐藏文件（以 . 开头的文件）')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.includeHiddenFiles)
				.onChange(async (value) => {
					this.plugin.settings.includeHiddenFiles = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('文件扩展名')
			.setDesc('要搜索的文件扩展名（用逗号分隔）')
			.addText(text => text
				.setPlaceholder('md,txt,json,js,ts')
				.setValue(this.plugin.settings.fileExtensions.join(','))
				.onChange(async (value) => {
					this.plugin.settings.fileExtensions = value.split(',').map(ext => ext.trim());
					await this.plugin.saveSettings();
				}));
	}
}