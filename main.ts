import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, MarkdownView, debounce, Menu } from 'obsidian';

// 常量定义
const PLUGIN_CONFIG = {
	MAX_REGEX_COMPLEXITY: 1000,
	MAX_FILE_SIZE: 10 * 1024 * 1024, // 10MB
	BATCH_SIZE: 5,
	SEARCH_BATCH_SIZE: 10,
	DEBOUNCE_DELAY: 300,
	PROGRESS_UPDATE_INTERVAL: 100,
	HIGHLIGHT_DURATION: 3000,
	MAX_CONTEXT_LINES: 3,
	MAX_RESULTS_PER_FILE: 100,
	MIN_SEARCH_LENGTH: 1,
	MAX_SEARCH_LENGTH: 500,
	TIMEOUT_DURATION: 30000 // 30秒超时
};

// 错误类型定义
class RegexValidationError extends Error {
	constructor(message: string, public readonly pattern: string) {
		super(message);
		this.name = 'RegexValidationError';
	}
}

class SearchTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SearchTimeoutError';
	}
}

// 实用工具类
class RegexUtils {
	static validateRegex(pattern: string, flags: string): RegExp {
		if (!pattern || pattern.length === 0) {
			throw new RegexValidationError('正则表达式不能为空', pattern);
		}
		
		if (pattern.length > PLUGIN_CONFIG.MAX_SEARCH_LENGTH) {
			throw new RegexValidationError(`正则表达式过长（最大${PLUGIN_CONFIG.MAX_SEARCH_LENGTH}字符）`, pattern);
		}
		
		// 检查潜在的复杂性
		const complexityScore = this.calculateComplexity(pattern);
		if (complexityScore > PLUGIN_CONFIG.MAX_REGEX_COMPLEXITY) {
			throw new RegexValidationError('正则表达式过于复杂，可能导致性能问题', pattern);
		}
		
		try {
			return new RegExp(pattern, flags);
		} catch (error) {
			throw new RegexValidationError(`正则表达式语法错误: ${error.message}`, pattern);
		}
	}
	
	static calculateComplexity(pattern: string): number {
		let complexity = 0;
		
		// 基础复杂度
		complexity += pattern.length;
		
		// 量词复杂度
		complexity += (pattern.match(/[*+?{]/g) || []).length * 10;
		
		// 回溯组复杂度
		complexity += (pattern.match(/\(/g) || []).length * 5;
		
		// 字符类复杂度
		complexity += (pattern.match(/\[/g) || []).length * 3;
		
		// 预查复杂度
		complexity += (pattern.match(/\?\=/g) || []).length * 20;
		
		return complexity;
	}
	
	static sanitizeInput(input: string): string {
		return input.trim().replace(/[\x00-\x1F\x7F]/g, '');
	}
	
	static escapeRegex(text: string): string {
		return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
}

// 搜索历史管理
class SearchHistory {
	private history: string[] = [];
	private maxSize: number = 20;
	
	add(pattern: string) {
		if (!pattern || pattern.length === 0) return;
		
		// 移除重复项
		const index = this.history.indexOf(pattern);
		if (index > -1) {
			this.history.splice(index, 1);
		}
		
		// 添加到开头
		this.history.unshift(pattern);
		
		// 保持最大长度
		if (this.history.length > this.maxSize) {
			this.history = this.history.slice(0, this.maxSize);
		}
	}
	
	get(): string[] {
		return [...this.history];
	}
	
	clear() {
		this.history = [];
	}
}

// 搜索任务管理
class SearchTask {
	private abortController: AbortController;
	private timeoutId: number | undefined;
	
	constructor(private timeoutMs: number = PLUGIN_CONFIG.TIMEOUT_DURATION) {
		this.abortController = new AbortController();
	}
	
	get signal(): AbortSignal {
		return this.abortController.signal;
	}
	
	start(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.timeoutId = window.setTimeout(() => {
				this.cancel();
				reject(new SearchTimeoutError('搜索超时'));
			}, this.timeoutMs);
			
			this.abortController.signal.addEventListener('abort', () => {
				if (this.timeoutId) {
					clearTimeout(this.timeoutId);
				}
				reject(new Error('搜索已取消'));
			});
		});
	}
	
	cancel() {
		if (this.timeoutId) {
			clearTimeout(this.timeoutId);
		}
		this.abortController.abort();
	}
	
	complete() {
		if (this.timeoutId) {
			clearTimeout(this.timeoutId);
		}
	}
}

// 在现有接口定义之前添加状态管理相关的枚举和类型
enum SearchState {
	Idle = 'idle',          // 空闲状态 - 可以开始新搜索
	Searching = 'searching', // 搜索中 - 正在执行搜索操作
	Replacing = 'replacing', // 替换中 - 正在执行替换操作
	Cancelled = 'cancelled', // 已取消 - 操作被用户取消
	Error = 'error'         // 错误状态 - 操作出现异常
}

interface StateTransition {
	from: SearchState[];
	to: SearchState;
	action?: string;
}

// 定义状态转换规则
const STATE_TRANSITIONS: Record<string, StateTransition> = {
	startSearch: { from: [SearchState.Idle], to: SearchState.Searching, action: 'search' },
	startReplace: { from: [SearchState.Idle], to: SearchState.Replacing, action: 'replace' },
	completeOperation: { from: [SearchState.Searching, SearchState.Replacing], to: SearchState.Idle },
	cancelOperation: { from: [SearchState.Searching, SearchState.Replacing], to: SearchState.Cancelled },
	handleError: { from: [SearchState.Searching, SearchState.Replacing], to: SearchState.Error },
	reset: { from: [SearchState.Cancelled, SearchState.Error], to: SearchState.Idle }
};

// 接口定义
interface RegexSearchSettings {
	defaultPattern: string;
	caseSensitive: boolean;
	multiline: boolean;
	maxResultsPerFile: number;
	includeHiddenFiles: boolean;
	fileExtensions: string[];
	searchHistory: string[];
	enableSearchHistory: boolean;
	confirmReplace: boolean;
	enableProgressIndicator: boolean;
	excludePatterns: string[];
	enableDebugLogging: boolean;
}

const DEFAULT_SETTINGS: RegexSearchSettings = {
	defaultPattern: '',
	caseSensitive: false,
	multiline: false,
	maxResultsPerFile: 50,
	includeHiddenFiles: false,
	fileExtensions: ['md', 'txt', 'json'],
	searchHistory: [],
	enableSearchHistory: true,
	confirmReplace: true,
	enableProgressIndicator: true,
	excludePatterns: [],
	enableDebugLogging: false
};

interface SearchMatch {
	file: TFile;
	line: number;
	column: number;
	match: string;
	context: string;
	lineText: string;
	matchId: string;
}

interface SearchResult {
	file: TFile;
	matches: SearchMatch[];
	totalMatches: number;
	searchTime: number;
	error?: string;
}

interface ReplaceResult {
	file: TFile;
	replacedCount: number;
	originalContent: string;
	newContent: string;
	error?: string;
}

interface VaultReplaceResult {
	totalReplacements: number;
	filesModified: number;
	results: ReplaceResult[];
	errors: string[];
	processingTime: number;
}

interface SearchProgress {
	current: number;
	total: number;
	currentFile?: string;
	isComplete: boolean;
}

export default class RegexSearchPlugin extends Plugin {
	settings: RegexSearchSettings;
	private searchHistory: SearchHistory;
	private currentSearchTask: SearchTask | null = null;

	async onload() {
		await this.loadSettings();
		this.searchHistory = new SearchHistory();
		
		// 恢复搜索历史
		if (this.settings.enableSearchHistory) {
			this.settings.searchHistory.forEach(pattern => {
				this.searchHistory.add(pattern);
			});
		}

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

		// 添加快速搜索命令
		this.addCommand({
			id: 'quick-regex-search',
			name: '快速正则表达式搜索',
			callback: () => {
				new QuickSearchModal(this.app, this).open();
			}
		});

		// 添加设置选项卡
		this.addSettingTab(new RegexSearchSettingTab(this.app, this));

		// 添加状态栏项目
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Regex Search');
		statusBarItemEl.addClass('regex-search-statusbar');
	}

	onunload() {
		// 取消当前搜索任务
		if (this.currentSearchTask) {
			this.currentSearchTask.cancel();
		}
		
		// 保存搜索历史
		if (this.settings.enableSearchHistory) {
			this.settings.searchHistory = this.searchHistory.get();
			this.saveSettings();
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// 文件过滤器
	private filterFiles(files: TFile[]): TFile[] {
		return files.filter(file => {
			// 检查文件扩展名
			if (!this.settings.fileExtensions.includes(file.extension)) {
				return false;
			}
			
			// 检查是否包含隐藏文件
			if (!this.settings.includeHiddenFiles && file.name.startsWith('.')) {
				return false;
			}
			
			// 检查排除模式
			if (this.settings.excludePatterns.length > 0) {
				const filePath = file.path;
				return !this.settings.excludePatterns.some(pattern => {
					try {
						const regex = new RegExp(pattern, 'i');
						return regex.test(filePath);
					} catch {
						return filePath.includes(pattern);
					}
				});
			}
			
			return true;
		});
	}

	// 检查文件大小
	private async checkFileSize(file: TFile): Promise<boolean> {
		try {
			const stat = await this.app.vault.adapter.stat(file.path);
			return stat && stat.size <= PLUGIN_CONFIG.MAX_FILE_SIZE;
		} catch {
			return true; // 如果无法获取文件大小，仍然尝试处理
		}
	}

	// 核心搜索方法（改进版）
	async searchInFile(file: TFile, pattern: string, flags: string, signal?: AbortSignal): Promise<SearchResult> {
		const startTime = Date.now();
		
		try {
			// 检查文件大小
			const isFileSizeOk = await this.checkFileSize(file);
			if (!isFileSizeOk) {
				return {
					file: file,
					matches: [],
					totalMatches: 0,
					searchTime: Date.now() - startTime,
					error: '文件过大，跳过搜索'
				};
			}
			
			// 检查是否取消
			if (signal?.aborted) {
				throw new Error('搜索已取消');
			}
			
			const content = await this.app.vault.read(file);
			const regex = RegexUtils.validateRegex(pattern, flags);
			const matches: SearchMatch[] = [];
			
			// 检查是否取消
			if (signal?.aborted) {
				throw new Error('搜索已取消');
			}
			
			await this.performSearch(content, regex, file, matches, signal);
			
			return {
				file: file,
				matches: matches,
				totalMatches: matches.length,
				searchTime: Date.now() - startTime
			};
		} catch (error) {
			return {
				file: file,
				matches: [],
				totalMatches: 0,
				searchTime: Date.now() - startTime,
				error: error.message
			};
		}
	}

	// 执行搜索的核心逻辑
	private async performSearch(content: string, regex: RegExp, file: TFile, matches: SearchMatch[], signal?: AbortSignal): Promise<void> {
		const lines = content.split('\n');
		const maxResults = Math.min(this.settings.maxResultsPerFile, PLUGIN_CONFIG.MAX_RESULTS_PER_FILE);
		
		// 判断是否需要全文搜索
		const needsFullTextSearch = this.needsFullTextSearch(regex);
		
		if (needsFullTextSearch) {
			await this.performFullTextSearch(content, regex, file, matches, maxResults, signal);
		} else {
			await this.performLineByLineSearch(lines, regex, file, matches, maxResults, signal);
		}
	}

	private needsFullTextSearch(regex: RegExp): boolean {
		const pattern = regex.source;
		const flags = regex.flags;
		
		return flags.includes('m') || 
			   /\\[1-9]/.test(pattern) ||
			   pattern.includes('\\n') || 
			   pattern.includes('\\r') ||
			   (pattern.includes('\\s') && (pattern.includes('.*') || pattern.includes('.+'))) ||
			   pattern.includes('.*') || 
			   pattern.includes('.+');
	}

	private async performFullTextSearch(content: string, regex: RegExp, file: TFile, matches: SearchMatch[], maxResults: number, signal?: AbortSignal): Promise<void> {
		const lines = content.split('\n');
		let match: RegExpMatchArray | null;
		
		regex.lastIndex = 0;
		
		while ((match = regex.exec(content)) !== null && matches.length < maxResults) {
			if (signal?.aborted) {
				throw new Error('搜索已取消');
			}
			
			const beforeMatch = content.substring(0, match.index);
			const lineNumber = beforeMatch.split('\n').length;
			const lineStart = beforeMatch.lastIndexOf('\n') + 1;
			const columnNumber = match.index - lineStart + 1;
			
			const context = this.getContext(lines, lineNumber - 1);
			const lineText = lines[lineNumber - 1] || '';
			
			matches.push({
				file: file,
				line: lineNumber,
				column: columnNumber,
				match: match[0],
				context: context,
				lineText: lineText,
				matchId: `${file.path}-${lineNumber}-${columnNumber}`
			});
			
			if (!regex.flags.includes('g')) {
				break;
			}
			
			// 定期让出控制权
			if (matches.length % 10 === 0) {
				await new Promise(resolve => setTimeout(resolve, 0));
			}
		}
	}

	private async performLineByLineSearch(lines: string[], regex: RegExp, file: TFile, matches: SearchMatch[], maxResults: number, signal?: AbortSignal): Promise<void> {
		for (let lineIndex = 0; lineIndex < lines.length && matches.length < maxResults; lineIndex++) {
			if (signal?.aborted) {
				throw new Error('搜索已取消');
			}
			
			const line = lines[lineIndex];
			let match: RegExpMatchArray | null;
			
			regex.lastIndex = 0;
			
			while ((match = regex.exec(line)) !== null && matches.length < maxResults) {
				const context = this.getContext(lines, lineIndex);
				
				matches.push({
					file: file,
					line: lineIndex + 1,
					column: match.index + 1,
					match: match[0],
					context: context,
					lineText: line,
					matchId: `${file.path}-${lineIndex + 1}-${match.index + 1}`
				});
				
				if (!regex.flags.includes('g')) {
					break;
				}
			}
			
			// 定期让出控制权
			if (lineIndex % 100 === 0) {
				await new Promise(resolve => setTimeout(resolve, 0));
			}
		}
	}

	private getContext(lines: string[], lineIndex: number): string {
		const contextLines = [];
		const contextRange = Math.floor(PLUGIN_CONFIG.MAX_CONTEXT_LINES / 2);
		
		for (let i = Math.max(0, lineIndex - contextRange); 
			 i <= Math.min(lines.length - 1, lineIndex + contextRange); 
			 i++) {
			contextLines.push(lines[i]);
		}
		
		return contextLines.join('\n');
	}

	// 跨文件搜索方法（优化版本）
	async searchInVault(pattern: string, flags: string, progressCallback?: (progress: SearchProgress) => void): Promise<SearchResult[]> {
		// 取消之前的搜索任务
		if (this.currentSearchTask) {
			this.currentSearchTask.cancel();
		}
		
		this.currentSearchTask = new SearchTask();
		const signal = this.currentSearchTask.signal;
		
		try {
			const files = this.app.vault.getFiles();
			const filteredFiles = this.filterFiles(files);
			const results: SearchResult[] = [];
			
			if (filteredFiles.length === 0) {
				return results;
			}
			
			// 启动超时计时器
			const timeoutPromise = this.currentSearchTask.start();
			
			// 执行搜索
			const searchPromise = this.performVaultSearch(filteredFiles, pattern, flags, results, progressCallback, signal);
			
			// 等待搜索完成或超时
			await Promise.race([searchPromise, timeoutPromise]);
			
			this.currentSearchTask.complete();
			
			// 添加到搜索历史
			if (this.settings.enableSearchHistory) {
				this.searchHistory.add(pattern);
			}
			
			return results;
		} catch (error) {
			if (error instanceof SearchTimeoutError) {
				new Notice('搜索超时，请尝试更具体的搜索条件');
			}
			throw error;
		} finally {
			this.currentSearchTask = null;
		}
	}

	private async performVaultSearch(files: TFile[], pattern: string, flags: string, results: SearchResult[], progressCallback?: (progress: SearchProgress) => void, signal?: AbortSignal): Promise<void> {
		const batchSize = PLUGIN_CONFIG.SEARCH_BATCH_SIZE;
		
		for (let i = 0; i < files.length; i += batchSize) {
			if (signal?.aborted) {
				throw new Error('搜索已取消');
			}
			
			const batch = files.slice(i, i + batchSize);
			
			// 并行处理当前批次
			const batchPromises = batch.map(file => this.searchInFile(file, pattern, flags, signal));
			const batchResults = await Promise.all(batchPromises);
			
			// 添加有效结果
			for (const result of batchResults) {
				if (result.matches.length > 0) {
					results.push(result);
				}
			}
			
			// 更新进度
			if (progressCallback) {
				progressCallback({
					current: i + batch.length,
					total: files.length,
					currentFile: batch[batch.length - 1]?.name,
					isComplete: i + batch.length >= files.length
				});
			}
			
			// 让出控制权给 UI
			await new Promise(resolve => setTimeout(resolve, 0));
		}
	}

	// 构建正则表达式标志
	buildRegexFlags(): string {
		let flags = '';
		if (!this.settings.caseSensitive) flags += 'i';
		if (this.settings.multiline) flags += 'm';
		flags += 'g'; // 总是使用全局搜索
		return flags;
	}

	// 单文件替换方法（改进版）
	async replaceInFile(file: TFile, pattern: string, replacement: string, flags: string, signal?: AbortSignal): Promise<ReplaceResult> {
		try {
			if (signal?.aborted) {
				throw new Error('替换已取消');
			}
			
			const originalContent = await this.app.vault.read(file);
			const regex = RegexUtils.validateRegex(pattern, flags);
			
			// 计算替换次数
			const matches = originalContent.match(regex);
			const replacedCount = matches ? matches.length : 0;
			
			if (replacedCount === 0) {
				return {
					file: file,
					replacedCount: 0,
					originalContent: originalContent,
					newContent: originalContent
				};
			}
			
			// 执行替换
			const newContent = originalContent.replace(regex, replacement);
			
			// 保存文件
			if (newContent !== originalContent) {
				await this.app.vault.modify(file, newContent);
			}
			
			return {
				file: file,
				replacedCount: replacedCount,
				originalContent: originalContent,
				newContent: newContent
			};
		} catch (error) {
			return {
				file: file,
				replacedCount: 0,
				originalContent: '',
				newContent: '',
				error: error.message
			};
		}
	}

	// 跨文件替换方法（优化版本）
	async replaceInVault(pattern: string, replacement: string, flags: string, progressCallback?: (progress: SearchProgress) => void): Promise<VaultReplaceResult> {
		const startTime = Date.now();
		
		// 取消之前的搜索任务
		if (this.currentSearchTask) {
			this.currentSearchTask.cancel();
		}
		
		this.currentSearchTask = new SearchTask();
		const signal = this.currentSearchTask.signal;
		
		try {
			const files = this.app.vault.getFiles();
			const filteredFiles = this.filterFiles(files);
			const results: ReplaceResult[] = [];
			const errors: string[] = [];
			let totalReplacements = 0;
			let filesModified = 0;
			
			if (filteredFiles.length === 0) {
				return {
					totalReplacements: 0,
					filesModified: 0,
					results: [],
					errors: [],
					processingTime: Date.now() - startTime
				};
			}
			
			// 启动超时计时器
			const timeoutPromise = this.currentSearchTask.start();
			
			// 执行替换
			const replacePromise = this.performVaultReplace(filteredFiles, pattern, replacement, flags, results, errors, progressCallback, signal);
			
			// 等待替换完成或超时
			await Promise.race([replacePromise, timeoutPromise]);
			
			this.currentSearchTask.complete();
			
			// 统计结果
			for (const result of results) {
				if (result.replacedCount > 0) {
					totalReplacements += result.replacedCount;
					filesModified++;
				}
			}
			
			return {
				totalReplacements: totalReplacements,
				filesModified: filesModified,
				results: results,
				errors: errors,
				processingTime: Date.now() - startTime
			};
		} catch (error) {
			if (error instanceof SearchTimeoutError) {
				new Notice('替换超时，请尝试更具体的搜索条件');
			}
			throw error;
		} finally {
			this.currentSearchTask = null;
		}
	}

	private async performVaultReplace(files: TFile[], pattern: string, replacement: string, flags: string, results: ReplaceResult[], errors: string[], progressCallback?: (progress: SearchProgress) => void, signal?: AbortSignal): Promise<void> {
		const batchSize = PLUGIN_CONFIG.BATCH_SIZE;
		
		for (let i = 0; i < files.length; i += batchSize) {
			if (signal?.aborted) {
				throw new Error('替换已取消');
			}
			
			const batch = files.slice(i, i + batchSize);
			
			// 串行处理替换操作（避免同时修改过多文件）
			for (const file of batch) {
				try {
					const result = await this.replaceInFile(file, pattern, replacement, flags, signal);
					if (result.error) {
						errors.push(`${file.path}: ${result.error}`);
					} else {
						results.push(result);
					}
				} catch (error) {
					errors.push(`${file.path}: ${error.message}`);
				}
			}
			
			// 更新进度
			if (progressCallback) {
				progressCallback({
					current: i + batch.length,
					total: files.length,
					currentFile: batch[batch.length - 1]?.name,
					isComplete: i + batch.length >= files.length
				});
			}
			
			// 让出控制权给 UI
			await new Promise(resolve => setTimeout(resolve, 0));
		}
	}

	// 取消当前搜索
	cancelCurrentSearch() {
		if (this.currentSearchTask) {
			this.currentSearchTask.cancel();
			this.currentSearchTask = null;
		}
	}

	// 获取搜索历史
	getSearchHistory(): string[] {
		return this.searchHistory.get();
	}

	// 清空搜索历史
	clearSearchHistory() {
		this.searchHistory.clear();
		this.settings.searchHistory = [];
		this.saveSettings();
	}
}

// 快速搜索模态框
class QuickSearchModal extends Modal {
	plugin: RegexSearchPlugin;
	private searchInput: HTMLInputElement;
	private resultsContainer: HTMLElement;
	private currentResults: SearchResult[] = [];

	constructor(app: App, plugin: RegexSearchPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('quick-search-modal');

		// 创建搜索输入
		const searchContainer = contentEl.createDiv('quick-search-container');
		searchContainer.createEl('h3', { text: '🔍 快速搜索' });
		
		this.searchInput = searchContainer.createEl('input', {
			type: 'text',
			placeholder: '输入搜索内容...',
			cls: 'quick-search-input'
		});
		
		// 创建结果容器
		this.resultsContainer = contentEl.createDiv('quick-search-results');
		
		// 绑定搜索事件
		const debouncedSearch = debounce(this.performQuickSearch.bind(this), PLUGIN_CONFIG.DEBOUNCE_DELAY);
		this.searchInput.addEventListener('input', debouncedSearch);
		
		// 绑定键盘事件
		this.searchInput.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				this.close();
			} else if (e.key === 'Enter') {
				this.openFullSearch();
			}
		});
		
		this.searchInput.focus();
	}

	private async performQuickSearch() {
		const query = this.searchInput.value.trim();
		if (query.length < PLUGIN_CONFIG.MIN_SEARCH_LENGTH) {
			this.resultsContainer.empty();
			return;
		}
		
		try {
			// 转义特殊字符进行字面量搜索
			const escapedQuery = RegexUtils.escapeRegex(query);
			const flags = this.plugin.buildRegexFlags();
			
			// 只搜索前10个匹配的文件
			const files = this.plugin.app.vault.getFiles().slice(0, 10);
			const results: SearchResult[] = [];
			
			for (const file of files) {
				const result = await this.plugin.searchInFile(file, escapedQuery, flags);
				if (result.matches.length > 0) {
					results.push(result);
				}
			}
			
			this.displayQuickResults(results);
		} catch (error) {
			console.error('Quick search error:', error);
		}
	}

	private displayQuickResults(results: SearchResult[]) {
		this.resultsContainer.empty();
		this.currentResults = results;
		
		if (results.length === 0) {
			this.resultsContainer.createEl('div', { text: '未找到匹配项', cls: 'quick-search-no-results' });
			return;
		}
		
		results.forEach(result => {
			const fileEl = this.resultsContainer.createDiv('quick-search-file');
			fileEl.createEl('div', { text: result.file.name, cls: 'quick-search-filename' });
			
			result.matches.slice(0, 3).forEach(match => {
				const matchEl = fileEl.createDiv('quick-search-match');
				matchEl.createEl('span', { text: `第${match.line}行: `, cls: 'quick-search-line' });
				matchEl.createEl('span', { text: match.lineText, cls: 'quick-search-text' });
				
				matchEl.addEventListener('click', () => {
					this.jumpToMatch(match);
				});
			});
		});
	}

	private async jumpToMatch(match: SearchMatch) {
		this.close();
		
		const leaf = this.app.workspace.getLeaf();
		await leaf.openFile(match.file);
		
		setTimeout(() => {
			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (activeView && activeView.editor) {
				const editor = activeView.editor;
				const line = match.line - 1;
				const column = match.column - 1;
				
				editor.setCursor(line, column);
				editor.scrollIntoView({
					from: { line: line, ch: 0 },
					to: { line: line, ch: editor.getLine(line).length }
				}, true);
			}
		}, 100);
	}

	private openFullSearch() {
		this.close();
		new RegexSearchModal(this.app, this.plugin).open();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

// 主搜索模态框
class RegexSearchModal extends Modal {
	plugin: RegexSearchPlugin;
	currentFile: TFile | null;
	searchResults: SearchResult[] = [];
	private patternInput: HTMLInputElement;
	private replaceInput: HTMLInputElement;
	private currentState: SearchState = SearchState.Idle;
	private progressEl: HTMLElement;

	constructor(app: App, plugin: RegexSearchPlugin, currentFile?: TFile) {
		super(app);
		this.plugin = plugin;
		this.currentFile = currentFile || null;
	}

	// 状态管理方法
	private canTransitionTo(newState: SearchState): boolean {
		const transition = Object.values(STATE_TRANSITIONS).find(t => t.to === newState);
		return transition ? transition.from.includes(this.currentState) : false;
	}

	private transitionToState(newState: SearchState, action?: string): boolean {
		if (this.canTransitionTo(newState)) {
			const previousState = this.currentState;
			this.currentState = newState;
			this.onStateChanged(previousState, newState, action);
			return true;
		}
		console.warn(`Invalid state transition: ${this.currentState} -> ${newState}`);
		return false;
	}

	private onStateChanged(from: SearchState, to: SearchState, action?: string) {
		// 记录状态转换日志
		this.logStateTransition(from, to, action);
		
		// 状态变化时的回调，用于更新UI
		this.updateButtonStates();
		
		// 根据状态变化执行特定的逻辑
		switch (to) {
			case SearchState.Idle:
				this.hideProgress();
				break;
			case SearchState.Searching:
				this.showProgress('搜索中...');
				break;
			case SearchState.Replacing:
				this.showProgress('替换中...');
				break;
			case SearchState.Cancelled:
				this.hideProgress();
				new Notice('操作已取消');
				// 自动回到空闲状态
				setTimeout(() => this.transitionToState(SearchState.Idle), 1000);
				break;
			case SearchState.Error:
				this.hideProgress();
				// 自动回到空闲状态
				setTimeout(() => this.transitionToState(SearchState.Idle), 2000);
				break;
		}
	}

	// 状态调试和监控方法
	private logStateTransition(from: SearchState, to: SearchState, action?: string) {
		if (this.plugin.settings.enableDebugLogging) {
			console.log(`🔄 状态转换: ${from} -> ${to}${action ? ` (${action})` : ''}`);
		}
	}

	private getStateDisplayName(state: SearchState): string {
		const stateNames = {
			[SearchState.Idle]: '空闲',
			[SearchState.Searching]: '搜索中',
			[SearchState.Replacing]: '替换中',
			[SearchState.Cancelled]: '已取消',
			[SearchState.Error]: '错误'
		};
		return stateNames[state] || state;
	}

	// 获取当前状态信息（用于调试）
	public getCurrentStateInfo(): { state: SearchState; displayName: string; canSearch: boolean; canReplace: boolean } {
		return {
			state: this.currentState,
			displayName: this.getStateDisplayName(this.currentState),
			canSearch: this.isIdle(),
			canReplace: this.isIdle()
		};
	}

	// 便捷的状态检查方法
	private isIdle(): boolean { return this.currentState === SearchState.Idle; }
	private isSearching(): boolean { return this.currentState === SearchState.Searching; }
	private isReplacing(): boolean { return this.currentState === SearchState.Replacing; }
	private isOperating(): boolean { return this.isSearching() || this.isReplacing(); }

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('regex-search-modal');

		// 设置模态框样式 - 初始为小尺寸
		this.modalEl.style.width = '100%';
		this.modalEl.style.maxWidth = '480px';
		this.modalEl.style.overflowX = 'hidden';
		this.modalEl.style.height = 'auto';
		this.modalEl.style.maxHeight = '85vh';
		this.contentEl.style.boxSizing = 'border-box';
		this.contentEl.style.overflowWrap = 'anywhere';
		this.contentEl.style.wordBreak = 'break-all';
		this.contentEl.style.padding = '0';
		this.contentEl.style.margin = '0';

		// 创建标题
		const titleEl = contentEl.createEl('h2', { 
			text: this.currentFile ? `🔍 在 ${this.currentFile.name} 中搜索` : '🎯 正则表达式搜索',
			cls: 'regex-search-title'
		});

		// 创建搜索表单
		const searchContainer = contentEl.createDiv('regex-search-container');
		
		// 正则表达式输入
		const patternContainer = searchContainer.createDiv('regex-pattern-container');
		patternContainer.createEl('label', { text: '⚡ 正则表达式：' });
		
		this.patternInput = patternContainer.createEl('input', { 
			type: 'text',
			placeholder: '输入正则表达式...',
			value: this.plugin.settings.defaultPattern,
			cls: 'regex-pattern-input'
		});
		
		this.patternInput.focus();

		// 添加搜索历史按钮（新位置）
		if (this.plugin.settings.enableSearchHistory) {
			const historyContainer = searchContainer.createDiv('regex-history-container');
			this.createHistoryDropdown(historyContainer);
		}

		// 替换输入框
		const replaceContainer = searchContainer.createDiv('regex-replace-container');
		replaceContainer.createEl('label', { text: '✨ 替换为：' });
		this.replaceInput = replaceContainer.createEl('input', { 
			type: 'text',
			placeholder: '输入替换内容...',
			value: '',
			cls: 'regex-replace-input'
		});

		// 搜索选项
		const optionsContainer = searchContainer.createDiv('regex-options-container');
		
		const caseSensitiveToggle = this.createToggle(optionsContainer, '🔤 区分大小写', this.plugin.settings.caseSensitive);
		const multilineToggle = this.createToggle(optionsContainer, '📝 多行模式', this.plugin.settings.multiline);

		// 进度指示器
		this.progressEl = searchContainer.createDiv('regex-progress');
		this.progressEl.style.display = 'none';

		// 按钮容器
		const buttonContainer = searchContainer.createDiv('regex-button-container');
		const searchButton = buttonContainer.createEl('button', { text: '🔍 搜索', cls: 'regex-search-button' });
		const replaceButton = buttonContainer.createEl('button', { text: '🔄 替换', cls: 'regex-replace-button' });
		const cancelButton = buttonContainer.createEl('button', { text: '❌ 取消', cls: 'regex-cancel-button' });
		const clearButton = buttonContainer.createEl('button', { text: '🧹 清空结果', cls: 'regex-clear-button' });

		// 结果容器
		const resultsContainer = contentEl.createDiv('regex-results-container');

		// 绑定事件
		this.bindEvents(searchButton, replaceButton, cancelButton, clearButton, resultsContainer, caseSensitiveToggle, multilineToggle);
	}

	private createHistoryDropdown(container: HTMLElement) {
		const historyButton = container.createEl('button', { text: '📚 历史', cls: 'regex-history-button' });
		historyButton.addEventListener('click', () => {
			this.showHistoryMenu(historyButton);
		});
	}

	private showHistoryMenu(button: HTMLElement) {
		const history = this.plugin.getSearchHistory();
		if (history.length === 0) {
			new Notice('没有搜索历史');
			return;
		}

		const menu = new Menu();
		history.forEach(pattern => {
			menu.addItem((item) => {
				item.setTitle(pattern);
				item.onClick(() => {
					this.patternInput.value = pattern;
					this.patternInput.focus();
				});
			});
		});

		menu.addSeparator();
		menu.addItem((item) => {
			item.setTitle('清空历史');
			item.onClick(() => {
				this.plugin.clearSearchHistory();
				new Notice('搜索历史已清空');
			});
		});

		const rect = button.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom });
	}

	private createToggle(container: HTMLElement, label: string, defaultValue: boolean): HTMLInputElement {
		const toggleContainer = container.createDiv('regex-toggle-container');
		const checkbox = toggleContainer.createEl('input', { type: 'checkbox' });
		checkbox.checked = defaultValue;
		toggleContainer.createEl('label', { text: label });
		return checkbox;
	}

	private bindEvents(searchButton: HTMLButtonElement, replaceButton: HTMLButtonElement, cancelButton: HTMLButtonElement, clearButton: HTMLButtonElement, resultsContainer: HTMLElement, caseSensitiveToggle: HTMLInputElement, multilineToggle: HTMLInputElement) {
		// 搜索函数
		const performSearch = async () => {
			if (!this.isIdle()) return;
			
			const pattern = RegexUtils.sanitizeInput(this.patternInput.value);
			if (!pattern) {
				new Notice('请输入正则表达式');
				return;
			}

			try {
				this.transitionToState(SearchState.Searching);
				
				// 构建标志
				let flags = '';
				if (!caseSensitiveToggle.checked) flags += 'i';
				if (multilineToggle.checked) flags += 'm';
				flags += 'g';

				// 验证正则表达式
				RegexUtils.validateRegex(pattern, flags);

				// 执行搜索
				resultsContainer.empty();

				let results: SearchResult[];
				if (this.currentFile) {
					const result = await this.plugin.searchInFile(this.currentFile, pattern, flags);
					results = result.matches.length > 0 ? [result] : [];
				} else {
					results = await this.plugin.searchInVault(pattern, flags, (progress) => {
						this.updateProgress(`搜索中... (${progress.current}/${progress.total})`);
					});
				}

				this.displayResults(results, resultsContainer);
				this.transitionToState(SearchState.Idle);
			} catch (error) {
				if (error instanceof RegexValidationError) {
					new Notice(error.message);
				} else {
					new Notice('搜索出错：' + error.message);
				}
				this.transitionToState(SearchState.Error);
			}
		};

		// 替换函数
		const performReplace = async () => {
			if (!this.isIdle()) return;
			
			const pattern = RegexUtils.sanitizeInput(this.patternInput.value);
			const replacement = this.replaceInput.value;
			
			if (!pattern) {
				new Notice('请输入正则表达式');
				return;
			}

			// 确认替换
			if (this.plugin.settings.confirmReplace && !this.currentFile) {
				const confirmed = await this.confirmReplace(pattern, replacement);
				if (!confirmed) return;
			}

			try {
				this.transitionToState(SearchState.Replacing);
				
				// 构建标志
				let flags = '';
				if (!caseSensitiveToggle.checked) flags += 'i';
				if (multilineToggle.checked) flags += 'm';
				flags += 'g';

				// 验证正则表达式
				RegexUtils.validateRegex(pattern, flags);

				// 执行替换
				resultsContainer.empty();

				let totalReplacements = 0;
				let filesModified = 0;

				if (this.currentFile) {
					const result = await this.plugin.replaceInFile(this.currentFile, pattern, replacement, flags);
					totalReplacements = result.replacedCount;
					filesModified = result.replacedCount > 0 ? 1 : 0;
				} else {
					const result = await this.plugin.replaceInVault(pattern, replacement, flags, (progress) => {
						this.updateProgress(`替换中... (${progress.current}/${progress.total})`);
					});
					totalReplacements = result.totalReplacements;
					filesModified = result.filesModified;
				}

				this.displayReplaceResults(totalReplacements, filesModified, resultsContainer);
				this.transitionToState(SearchState.Idle);

			} catch (error) {
				if (error instanceof RegexValidationError) {
					new Notice(error.message);
				} else {
					new Notice('替换出错：' + error.message);
				}
				this.transitionToState(SearchState.Error);
			}
		};

		// 取消函数
		const cancelSearch = () => {
			this.plugin.cancelCurrentSearch();
			this.transitionToState(SearchState.Cancelled);
		};

		// 清空结果
		const clearResults = () => {
			resultsContainer.empty();
			resultsContainer.classList.remove('has-content');
			// 恢复为小尺寸
			this.containerEl.classList.remove('has-results');
			this.searchResults = [];
		};

		// 绑定事件
		searchButton.addEventListener('click', performSearch);
		replaceButton.addEventListener('click', performReplace);
		cancelButton.addEventListener('click', cancelSearch);
		clearButton.addEventListener('click', clearResults);

		// 键盘事件
		const handleKeydown = (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				if (e.ctrlKey || e.metaKey) {
					e.preventDefault();
					performReplace();
				} else {
					e.preventDefault();
					performSearch();
				}
			} else if (e.key === 'Escape') {
				if (this.isOperating()) {
					cancelSearch();
				} else {
					this.close();
				}
			}
		};
		
		this.patternInput.addEventListener('keydown', handleKeydown);
		this.replaceInput.addEventListener('keydown', handleKeydown);
	}

	private updateButtonStates() {
		const searchButton = this.containerEl.querySelector('.regex-search-button') as HTMLButtonElement;
		const replaceButton = this.containerEl.querySelector('.regex-replace-button') as HTMLButtonElement;
		const cancelButton = this.containerEl.querySelector('.regex-cancel-button') as HTMLButtonElement;
		
		const isOperating = this.isOperating();
		if (searchButton) searchButton.disabled = isOperating;
		if (replaceButton) replaceButton.disabled = isOperating;
		if (cancelButton) cancelButton.style.display = isOperating ? 'block' : 'none';
	}

	private showProgress(message: string) {
		this.progressEl.textContent = message;
		this.progressEl.style.display = 'block';
	}

	private updateProgress(message: string) {
		this.progressEl.textContent = message;
	}

	private hideProgress() {
		this.progressEl.style.display = 'none';
	}

	private async confirmReplace(pattern: string, replacement: string): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new ConfirmModal(this.app, {
				title: '确认替换',
				message: `确定要在整个库中执行替换操作吗？\n\n模式：${pattern}\n替换为：${replacement}`,
				confirmText: '确定',
				cancelText: '取消'
			}, resolve);
			modal.open();
		});
	}

	private displayReplaceResults(totalReplacements: number, filesModified: number, container: HTMLElement) {
		container.empty();
		
		// 显示结果容器并放大模态框
		container.classList.add('has-content');
		this.containerEl.classList.add('has-results');
		
		if (totalReplacements > 0) {
			const successEl = container.createEl('div', { cls: 'regex-replace-success' });
			successEl.createEl('div', { text: `✅ 替换完成！` });
			successEl.createEl('div', { text: `共替换 ${totalReplacements} 处，涉及 ${filesModified} 个文件` });
		} else {
			container.createEl('div', { 
				text: '未找到匹配的内容',
				cls: 'regex-no-results'
			});
		}
	}

	private displayResults(results: SearchResult[], container: HTMLElement) {
		container.empty();
		this.searchResults = results;

		if (results.length === 0) {
			container.createEl('div', { text: '未找到匹配项', cls: 'regex-no-results' });
			container.classList.add('has-content');
			// 即使没结果也稍微放大一点显示提示
			this.containerEl.classList.add('has-results');
			return;
		}

		// 显示结果容器并放大模态框
		container.classList.add('has-content');
		this.containerEl.classList.add('has-results');

		// 统计信息
		const totalMatches = results.reduce((sum, result) => sum + result.totalMatches, 0);
		const statsEl = container.createEl('div', { cls: 'regex-stats' });
		statsEl.createEl('span', { text: `找到 ${totalMatches} 个匹配项，分布在 ${results.length} 个文件中` });

		// 显示结果
		results.forEach((result) => {
			if (result.error) {
				const errorEl = container.createEl('div', { cls: 'regex-error' });
				errorEl.createEl('strong', { text: result.file.name });
				errorEl.createEl('span', { text: ` - 错误：${result.error}` });
				return;
			}

			const fileContainer = container.createDiv('regex-file-result');
			
			// 文件标题
			const fileTitle = fileContainer.createEl('div', { cls: 'regex-file-title' });
			fileTitle.createEl('strong', { text: result.file.name });
			fileTitle.createEl('span', { text: ` (${result.totalMatches} 个匹配项)` });

			// 匹配项
			const matchesContainer = fileContainer.createDiv('regex-matches-container');
			result.matches.forEach((match) => {
				const matchEl = matchesContainer.createDiv('regex-match');
				matchEl.setAttribute('data-match-id', match.matchId);
				
				// 位置信息
				const locationEl = matchEl.createEl('div', { cls: 'regex-match-location' });
				locationEl.createEl('span', { text: `第 ${match.line} 行，第 ${match.column} 列` });
				
				// 匹配内容
				const contentEl = matchEl.createEl('div', { cls: 'regex-match-content' });
				this.renderMatchContent(contentEl, match);

				// 点击跳转
				matchEl.addEventListener('click', () => {
					this.jumpToMatch(match);
				});
			});
		});
	}

	private renderMatchContent(contentEl: HTMLElement, match: SearchMatch) {
		const contextLines = match.context.split('\n');
		contextLines.forEach((line, lineIndex) => {
			const lineEl = contentEl.createEl('div', { cls: 'regex-context-line' });
			
			// 检查是否是匹配行
			const isMatchLine = line === match.lineText;
			if (isMatchLine) {
				lineEl.addClass('regex-match-line');
				
				// 高亮匹配内容
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
	}

	private async jumpToMatch(match: SearchMatch) {
		try {
			// 添加加载状态
			const matchEl = this.containerEl.querySelector(`[data-match-id="${match.matchId}"]`);
			if (matchEl) {
				matchEl.addClass('loading');
			}
			
			// 关闭搜索模态窗口
			this.close();
			
			// 打开文件并跳转到具体位置
			const leaf = this.app.workspace.getLeaf();
			await leaf.openFile(match.file);
			
			// 等待文件加载完成
			setTimeout(() => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView && activeView.editor) {
					this.highlightMatch(activeView.editor, match);
				}
			}, 100);
		} catch (error) {
			new Notice('跳转失败：' + error.message);
		}
	}

	private highlightMatch(editor: any, match: SearchMatch) {
		try {
			const line = match.line - 1;
			const column = match.column - 1;
			const matchLength = match.match.length;
			
			// 设置光标位置
			editor.setCursor(line, column);
			
			// 滚动到视图中心
			editor.scrollIntoView({
				from: { line: line, ch: 0 },
				to: { line: line, ch: editor.getLine(line).length }
			}, true);
			
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
			}, PLUGIN_CONFIG.HIGHLIGHT_DURATION);
		} catch (error) {
			console.error('高亮匹配文本时出错:', error);
		}
	}

	onClose() {
		// 取消当前搜索
		if (this.isOperating()) {
			this.plugin.cancelCurrentSearch();
		}
		
		const { contentEl } = this;
		contentEl.empty();
	}
}

// 确认对话框
class ConfirmModal extends Modal {
	private callback: (confirmed: boolean) => void;
	private options: {
		title: string;
		message: string;
		confirmText: string;
		cancelText: string;
	};

	constructor(app: App, options: {
		title: string;
		message: string;
		confirmText: string;
		cancelText: string;
	}, callback: (confirmed: boolean) => void) {
		super(app);
		this.options = options;
		this.callback = callback;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('confirm-modal');

		// 标题
		contentEl.createEl('h3', { text: this.options.title });

		// 消息
		const messageEl = contentEl.createEl('div', { cls: 'confirm-message' });
		messageEl.createEl('p', { text: this.options.message });

		// 按钮
		const buttonContainer = contentEl.createDiv('confirm-buttons');
		
		const confirmButton = buttonContainer.createEl('button', { 
			text: this.options.confirmText,
			cls: 'confirm-button-confirm'
		});
		
		const cancelButton = buttonContainer.createEl('button', { 
			text: this.options.cancelText,
			cls: 'confirm-button-cancel'
		});

		// 事件处理
		confirmButton.addEventListener('click', () => {
			this.callback(true);
			this.close();
		});

		cancelButton.addEventListener('click', () => {
			this.callback(false);
			this.close();
		});

		// 键盘事件
		this.scope.register([], 'Enter', () => {
			this.callback(true);
			this.close();
		});

		this.scope.register([], 'Escape', () => {
			this.callback(false);
			this.close();
		});

		// 默认焦点
		cancelButton.focus();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

// 设置页面
class RegexSearchSettingTab extends PluginSettingTab {
	plugin: RegexSearchPlugin;
	
	constructor(app: App, plugin: RegexSearchPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: '🎯 正则表达式搜索设置' });

		// 基本设置
		this.createBasicSettings(containerEl);
		
		// 高级设置
		this.createAdvancedSettings(containerEl);
		
		// 性能设置
		this.createPerformanceSettings(containerEl);
		
		// 用户体验设置
		this.createUserExperienceSettings(containerEl);
	}

	private createBasicSettings(containerEl: HTMLElement) {
		const basicSection = containerEl.createEl('h3', { text: '⚙️ 基本设置' });

		new Setting(containerEl)
			.setName('默认搜索模式')
			.setDesc('打开搜索时的默认正则表达式模式')
			.addText(text => text
				.setPlaceholder('输入默认正则表达式...')
				.setValue(this.plugin.settings.defaultPattern)
				.onChange(async (value) => {
					this.plugin.settings.defaultPattern = RegexUtils.sanitizeInput(value);
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
			.setName('文件扩展名')
			.setDesc('要搜索的文件扩展名（用逗号分隔）')
			.addText(text => text
				.setPlaceholder('md,txt,json,js,ts')
				.setValue(this.plugin.settings.fileExtensions.join(','))
				.onChange(async (value) => {
					const extensions = value.split(',').map(ext => ext.trim()).filter(ext => ext.length > 0);
					this.plugin.settings.fileExtensions = extensions;
					await this.plugin.saveSettings();
				}));
	}

	private createAdvancedSettings(containerEl: HTMLElement) {
		const advancedSection = containerEl.createEl('h3', { text: '🔧 高级设置' });

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
			.setName('排除模式')
			.setDesc('要排除的文件路径模式（用逗号分隔，支持正则表达式）')
			.addText(text => text
				.setPlaceholder('node_modules,\\.git,temp')
				.setValue(this.plugin.settings.excludePatterns.join(','))
				.onChange(async (value) => {
					const patterns = value.split(',').map(pattern => pattern.trim()).filter(pattern => pattern.length > 0);
					this.plugin.settings.excludePatterns = patterns;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('确认替换')
			.setDesc('在执行全库替换操作前显示确认对话框')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.confirmReplace)
				.onChange(async (value) => {
					this.plugin.settings.confirmReplace = value;
					await this.plugin.saveSettings();
				}));
	}

	private createPerformanceSettings(containerEl: HTMLElement) {
		const performanceSection = containerEl.createEl('h3', { text: '⚡ 性能设置' });

		new Setting(containerEl)
			.setName('每个文件最大结果数')
			.setDesc('限制每个文件显示的最大搜索结果数量')
			.addText(text => text
				.setPlaceholder('50')
				.setValue(this.plugin.settings.maxResultsPerFile.toString())
				.onChange(async (value) => {
					const num = parseInt(value);
					if (!isNaN(num) && num > 0 && num <= PLUGIN_CONFIG.MAX_RESULTS_PER_FILE) {
						this.plugin.settings.maxResultsPerFile = num;
						await this.plugin.saveSettings();
					}
				}));
	}

	private createUserExperienceSettings(containerEl: HTMLElement) {
		const uxSection = containerEl.createEl('h3', { text: '🎨 用户体验设置' });

		new Setting(containerEl)
			.setName('启用搜索历史')
			.setDesc('保存和显示搜索历史记录')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableSearchHistory)
				.onChange(async (value) => {
					this.plugin.settings.enableSearchHistory = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('启用进度指示器')
			.setDesc('在搜索和替换过程中显示进度指示器')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableProgressIndicator)
				.onChange(async (value) => {
					this.plugin.settings.enableProgressIndicator = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('调试模式')
			.setDesc('启用后会在开发者控制台显示状态转换日志')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableDebugLogging)
				.onChange(async (value) => {
					this.plugin.settings.enableDebugLogging = value;
					await this.plugin.saveSettings();
				}));

		// 清空搜索历史按钮
		new Setting(containerEl)
			.setName('清空搜索历史')
			.setDesc('删除所有保存的搜索历史记录')
			.addButton(button => button
				.setButtonText('🗑️ 清空历史')
				.setWarning()
				.onClick(async () => {
					this.plugin.clearSearchHistory();
					new Notice('搜索历史已清空');
				}));
	}
}