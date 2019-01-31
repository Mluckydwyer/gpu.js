const {
	FunctionNode
} = require('../function-node');
// Closure capture for the ast function, prevent collision with existing AST functions
// The prefixes to use
const jsMathPrefix = 'Math.';
const localPrefix = 'this.';
const constantsPrefix = 'this.constants.';

const DECODE32_ENCODE32 = /decode32\(\s+encode32\(/g;
const ENCODE32_DECODE32 = /encode32\(\s+decode32\(/g;

/**
 * @desc [INTERNAL] Takes in a function node, and does all the AST voodoo required to toString its respective webGL code
 * @returns the converted webGL function string
 */
class WebGLFunctionNode extends FunctionNode {
	constructor(source, settings) {
		super(source, settings);
		this.fixIntegerDivisionAccuracy = null;
		if (settings && settings.hasOwnProperty('fixIntegerDivisionAccuracy')) {
			this.fixIntegerDivisionAccuracy = settings.fixIntegerDivisionAccuracy;
		}
		this._string = null;
	}

	toString() {
		if (this._string) return this._string;
		return this._string = webGlRegexOptimize(this.astGeneric(this.getJsAST(), []).join('').trim());
	}

	/**
	 * @desc Parses the abstract syntax tree for to its *named function prototype*
	 * @param {Object} ast - the AST object to parse
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astFunctionPrototype(ast, retArr) {
		// Setup function return type and name
		if (this.isRootKernel || this.isSubKernel) {
			return retArr;
		}

		const returnType = this.returnType;
		const type = typeMap[returnType];
		if (!type) {
			throw new Error(`unknown type ${ returnType }`);
		}
		retArr.push(type);
		retArr.push(' ');
		retArr.push(this.name);
		retArr.push('(');

		// Arguments handling
		for (let i = 0; i < this.argumentNames.length; ++i) {
			if (i > 0) {
				retArr.push(', ');
			}

			retArr.push(this.argumentTypes[i]);
			retArr.push(' ');
			retArr.push('user_');
			retArr.push(this.argumentNames[i]);
		}

		retArr.push(');\n');

		return retArr;
	}

	/**
	 * @desc Parses the abstract syntax tree for to its *named function*
	 * @param {Object} ast - the AST object to parse
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astFunctionExpression(ast, retArr) {

		// Setup function return type and name
		if (this.isRootKernel) {
			retArr.push('void');
		} else {
			const returnType = this.returnType;
			const type = typeMap[returnType];
			if (!type) {
				throw new Error(`unknown type ${ returnType }`);
			}
			retArr.push(type);
		}
		retArr.push(' ');
		retArr.push(this.name);
		retArr.push('(');

		if (!this.isRootKernel) {
			// Arguments handling
			for (let i = 0; i < this.argumentNames.length; ++i) {
				const argumentName = this.argumentNames[i];

				if (i > 0) {
					retArr.push(', ');
				}
				const argumentType = this.getVariableType(argumentName);
				const type = typeMap[argumentType];
				if (!type) {
					throw new Error(`unknown type ${ argumentType }`);
				}
				retArr.push(type);
				retArr.push(' ');
				retArr.push('user_');
				retArr.push(argumentName);
			}
		}

		// Function opening
		retArr.push(') {\n');

		// Body statement iteration
		for (let i = 0; i < ast.body.body.length; ++i) {
			this.astGeneric(ast.body.body[i], retArr);
			retArr.push('\n');
		}

		// Function closing
		retArr.push('}\n');
		return retArr;
	}

	/**
	 * @desc Parses the abstract syntax tree for to *return* statement
	 * @param {Object} ast - the AST object to parse
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astReturnStatement(ast, retArr) {
		if (this.isRootKernel) {
			retArr.push('kernelResult = ');
			this.astGeneric(ast.argument, retArr);
			retArr.push(';');
			retArr.push('return;');
		} else if (this.isSubKernel) {
			retArr.push(`subKernelResult_${ this.name } = `);
			this.astGeneric(ast.argument, retArr);
			retArr.push(';');
			retArr.push(`return subKernelResult_${ this.name };`);
		} else {
			retArr.push('return ');
			this.astGeneric(ast.argument, retArr);
			retArr.push(';');
		}
		return retArr;
	}

	/**
	 * @desc Parses the abstract syntax tree for *literal value*
	 *
	 * @param {Object} ast - the AST object to parse
	 * @param {Array} retArr - return array string
	 *
	 * @returns {Array} the append retArr
	 */
	astLiteral(ast, retArr) {

		// Reject non numeric literals
		if (isNaN(ast.value)) {
			throw this.astErrorOutput(
				'Non-numeric literal not supported : ' + ast.value,
				ast
			);
		}

		// Push the literal value as a float/int
		retArr.push(ast.value);

		const inGetParams = this.isState('in-get-call-parameters');
		const inForLoopInit = this.isState('in-for-loop-init');
		const isIntegerComparison = this.isState('integer-comparison');
		// If it was an int, node made a float if necessary
		if (Number.isInteger(ast.value)) {
			if (!inGetParams && !inForLoopInit && !isIntegerComparison) {
				retArr.push('.0');
			}
		} else if (inGetParams && !isIntegerComparison) {
			// or cast to an int as we are addressing an input array
			retArr.pop();
			retArr.push('int(');
			retArr.push(ast.value);
			retArr.push(')');
		}

		return retArr;
	}

	/**
	 * @desc Parses the abstract syntax tree for *binary* expression
	 * @param {Object} ast - the AST object to parse
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astBinaryExpression(ast, retArr) {
		const inGetParams = this.isState('in-get-call-parameters');
		if (inGetParams) {
			this.pushState('not-in-get-call-parameters');
			retArr.push('int');
		}
		retArr.push('(');

		if (ast.operator === '%') {
			retArr.push('mod(');
			this.astGeneric(ast.left, retArr);
			retArr.push(',');
			this.astGeneric(ast.right, retArr);
			retArr.push(')');
		} else if (ast.operator === '===') {
			this.astGeneric(ast.left, retArr);
			retArr.push('==');
			this.astGeneric(ast.right, retArr);
		} else if (ast.operator === '!==') {
			this.astGeneric(ast.left, retArr);
			retArr.push('!=');
			this.astGeneric(ast.right, retArr);
		} else if (this.fixIntegerDivisionAccuracy && ast.operator === '/') {
			retArr.push('div_with_int_check(');
			this.astGeneric(ast.left, retArr);
			retArr.push(', ');
			this.astGeneric(ast.right, retArr);
			retArr.push(')');
		} else {
			this.astGeneric(ast.left, retArr);
			retArr.push(ast.operator);

			const isInteger = this.declarations[this.astGetFirstAvailableName(ast.left)] === 'Integer';
			if (isInteger) {
				this.pushState('integer-comparison');
				this.astGeneric(ast.right, retArr);
				this.popState('integer-comparison');
			} else {
				this.astGeneric(ast.right, retArr);
			}
		}

		retArr.push(')');

		if (inGetParams) {
			this.popState('not-in-get-call-parameters');
		}

		return retArr;
	}

	/**
	 * @desc Parses the abstract syntax tree for *identifier* expression
	 * @param {Object} idtNode - An ast Node
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astIdentifierExpression(idtNode, retArr) {
		if (idtNode.type !== 'Identifier') {
			throw this.astErrorOutput(
				'IdentifierExpression - not an Identifier',
				idtNode
			);
		}
		// do we need to cast addressing vales to float?
		const castFloat = !this.isState('in-get-call-parameters');

		switch (idtNode.name) {
			case 'gpu_threadX':
				if (castFloat) {
					retArr.push('float(threadId.x)');
				} else {
					retArr.push('threadId.x');
				}
				break;
			case 'gpu_threadY':
				if (castFloat) {
					retArr.push('float(threadId.y)');
				} else {
					retArr.push('threadId.y');
				}
				break;
			case 'gpu_threadZ':
				if (castFloat) {
					retArr.push('float(threadId.z)');
				} else {
					retArr.push('threadId.z');
				}
				break;
			case 'gpu_outputX':
				retArr.push('uOutputDim.x');
				break;
			case 'gpu_outputY':
				retArr.push('uOutputDim.y');
				break;
			case 'gpu_outputZ':
				retArr.push('uOutputDim.z');
				break;
			case 'Infinity':
				// https://stackoverflow.com/a/47543127/1324039
				retArr.push('3.402823466e+38');
				break;
			default:
				const userArgumentName = this.getUserArgumentName(idtNode.name);
				if (userArgumentName !== null) {
					this.pushParameter(retArr, userArgumentName);
				} else {
					this.pushParameter(retArr, idtNode.name);
				}
		}

		return retArr;
	}

	/**
	 * @desc Parses the abstract syntax tree forfor *for-loop* expression
	 * @param {Object} forNode - An ast Node
	 * @param {Array} retArr - return array string
	 * @returns {Array} the parsed webgl string
	 */
	astForStatement(forNode, retArr) {
		if (forNode.type !== 'ForStatement') {
			throw this.astErrorOutput(
				'Invalid for statement',
				forNode
			);
		}

		if (forNode.test && forNode.test.type === 'BinaryExpression') {
			if (forNode.test.right.type === 'Identifier' &&
				forNode.test.operator === '<' &&
				this.isIdentifierConstant(this.astGetFirstAvailableName(forNode.test.right)) === false) {

				if (!this.loopMaxIterations) {
					console.warn('Warning: loopMaxIterations is not set! Using default of 1000 which may result in unintended behavior.');
					console.warn('Set loopMaxIterations or use a for loop of fixed length to silence this message.');
				}

				retArr.push('for (');
				this.pushState('in-for-loop-init');
				this.astGeneric(forNode.init, retArr);
				this.popState('in-for-loop-init');
				this.astGeneric(forNode.test.left, retArr);
				retArr.push(forNode.test.operator);
				retArr.push('LOOP_MAX');
				retArr.push(';');
				this.astGeneric(forNode.update, retArr);
				retArr.push(')');

				retArr.push('{\n');
				retArr.push('if (');
				const variableName = this.astGetFirstAvailableName(forNode.test.left);
				this.astGeneric(forNode.test.left, retArr);
				retArr.push(forNode.test.operator);
				if (this.declarations[variableName] === 'Integer') {
					this.pushState('integer-comparison');
					this.astGeneric(forNode.test.right, retArr);
					this.popState('integer-comparison');
				} else {
					this.astGeneric(forNode.test.right, retArr);
				}
				retArr.push(') {\n');
				if (forNode.body.type === 'BlockStatement') {
					for (let i = 0; i < forNode.body.body.length; i++) {
						this.astGeneric(forNode.body.body[i], retArr);
					}
				} else {
					this.astGeneric(forNode.body, retArr);
				}
				retArr.push('\n} else {\n');
				retArr.push('break;\n');
				retArr.push('}\n');
				retArr.push('}\n');

				return retArr;
			} else if (forNode.init.declarations) {
				const declarations = forNode.init.declarations;
				if (!Array.isArray(declarations) || declarations.length < 1) {
					throw new Error('Error: Incompatible for loop declaration');
				}

				if (declarations.length > 1) {
					retArr.push('for (');
					this.pushState('in-for-loop-init');
					retArr.push('int ');
					for (let i = 0; i < declarations.length; i++) {
						const declaration = declarations[i];
						if (i > 0) {
							retArr.push(',');
						}
						this.declarations[declaration.id.name] = 'Integer';
						this.astGeneric(declaration, retArr);
					}
					retArr.push(';');
					this.popState('in-for-loop-init');
				} else {
					retArr.push('for (');
					this.pushState('in-for-loop-init');
					this.astGeneric(forNode.init, retArr);
					this.popState('in-for-loop-init');
				}

				this.astGeneric(forNode.test, retArr);
				retArr.push(';');
				this.astGeneric(forNode.update, retArr);
				retArr.push(')');
				this.astGeneric(forNode.body, retArr);
				return retArr;
			}
		}

		throw this.astErrorOutput(
			'Invalid for statement',
			forNode
		);
	}

	/**
	 * @desc Parses the abstract syntax tree for *while* loop
	 * @param {Object} whileNode - An ast Node
	 * @param {Array} retArr - return array string
	 * @returns {Array} the parsed webgl string
	 */
	astWhileStatement(whileNode, retArr) {
		if (whileNode.type !== 'WhileStatement') {
			throw this.astErrorOutput(
				'Invalid while statment',
				whileNode
			);
		}

		retArr.push('for (int i = 0; i < LOOP_MAX; i++) {');
		retArr.push('if (');
		this.astGeneric(whileNode.test, retArr);
		retArr.push(') {\n');
		this.astGeneric(whileNode.body, retArr);
		retArr.push('} else {\n');
		retArr.push('break;\n');
		retArr.push('}\n');
		retArr.push('}\n');

		return retArr;
	}

	/**
	 * @desc Parses the abstract syntax tree for *do while* loop
	 * @param {Object} doWhileNode - An ast Node
	 * @param {Array} retArr - return array string
	 * @returns {Array} the parsed webgl string
	 */
	astDoWhileStatement(doWhileNode, retArr) {
		if (doWhileNode.type !== 'DoWhileStatement') {
			throw this.astErrorOutput(
				'Invalid while statment',
				doWhileNode
			);
		}

		retArr.push('for (int i = 0; i < LOOP_MAX; i++) {');
		this.astGeneric(doWhileNode.body, retArr);
		retArr.push('if (!');
		this.astGeneric(doWhileNode.test, retArr);
		retArr.push(') {\n');
		retArr.push('break;\n');
		retArr.push('}\n');
		retArr.push('}\n');

		return retArr;

	}


	/**
	 * @desc Parses the abstract syntax tree for *Assignment* Expression
	 * @param {Object} assNode - An ast Node
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astAssignmentExpression(assNode, retArr) {
		if (assNode.operator === '%=') {
			this.astGeneric(assNode.left, retArr);
			retArr.push('=');
			retArr.push('mod(');
			this.astGeneric(assNode.left, retArr);
			retArr.push(',');
			this.astGeneric(assNode.right, retArr);
			retArr.push(')');
		} else {
			const isLeftInteger = this.declarations[this.astGetFirstAvailableName(assNode.left)] === 'Integer';
			const isRightInteger = this.declarations[this.astGetFirstAvailableName(assNode.right)] === 'Integer';
			this.astGeneric(assNode.left, retArr);
			retArr.push(assNode.operator);
			if (!isLeftInteger && isRightInteger) {
				retArr.push('float(');
				this.astGeneric(assNode.right, retArr);
				retArr.push(')');
			} else {
				this.astGeneric(assNode.right, retArr);
			}
			return retArr;
		}
	}

	/**
	 * @desc Parses the abstract syntax tree for an *Empty* Statement
	 * @param {Object} eNode - An ast Node
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astEmptyStatement(eNode, retArr) {
		//retArr.push(';\n');
		return retArr;
	}

	/**
	 * @desc Parses the abstract syntax tree for *Block* statement
	 * @param {Object} bNode - the AST object to parse
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astBlockStatement(bNode, retArr) {
		retArr.push('{\n');
		for (let i = 0; i < bNode.body.length; i++) {
			this.astGeneric(bNode.body[i], retArr);
		}
		retArr.push('}\n');
		return retArr;
	}

	/**
	 * @desc Parses the abstract syntax tree for *generic expression* statement
	 * @param {Object} esNode - An ast Node
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astExpressionStatement(esNode, retArr) {
		this.astGeneric(esNode.expression, retArr);
		retArr.push(';');
		return retArr;
	}

	/**
	 * @desc Parses the abstract syntax tree for *Variable Declaration*
	 * @param {Object} varDecNode - An ast Node
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astVariableDeclaration(varDecNode, retArr) {
		for (let i = 0; i < varDecNode.declarations.length; i++) {
			const declaration = varDecNode.declarations[i];
			if (i > 0) {
				retArr.push(',');
			}
			const retDeclaration = [];
			this.astGeneric(declaration, retDeclaration);
			let declarationType = this.isState('in-for-loop-init') ? 'Integer' : 'Number';
			if (i === 0) {
				const init = declaration.init;
				if (init) {
					if (init.object) {
						if (
							init.object.type === 'MemberExpression' &&
							init.object.object
						) {
							// this.thread.x, this.thread.y, this.thread.z
							if (
								init.object.object.type === 'ThisExpression' &&
								init.object.property &&
								(
									init.object.property.name === 'thread' ||
									init.object.property.name === 'output'
								)
							) {
								declarationType = 'Float';
							}
							// param[]
							else if (init.object.object.type === 'Identifier') {
								const type = this.getVariableType(init.object.object.name);
								declarationType = typeLookupMap[type];
							}
							// param[][]
							else if (
								init.object.object.object &&
								init.object.object.object.type === 'Identifier'
							) {
								const type = this.getVariableType(init.object.object.object.name);
								declarationType = typeLookupMap[type];
							}
							// this.constants.param[]
							else if (
								init.object.object.object &&
								init.object.object.object.object &&
								init.object.object.object.object.type === 'ThisExpression' &&
								init.object.object.object.property.name === 'constants'
							) {
								const type = this.getConstantType(init.object.object.property.name);
								declarationType = typeLookupMap[type];
							}
							// this.constants.param[][]
							else if (
								init.object.object.object &&
								init.object.object.object.object &&
								init.object.object.object.object.object &&
								init.object.object.object.object.object.type === 'ThisExpression' &&
								init.object.object.object.object.property.name === 'constants'
							) {
								const type = this.getConstantType(init.object.object.object.property.name);
								declarationType = typeLookupMap[type];
							}
						}
						if (!declarationType) {
							throw new Error(`unknown lookup type ${ typeLookupMap }`);
						}
					} else {
						if (init.name && this.declarations[init.name]) {
							declarationType = this.declarations[init.name];
						} else if (init.type === 'ArrayExpression') {
							declarationType = `Array(${ init.elements.length })`;
						} else if (init.type === 'CallExpression' && this.lookupReturnType) {
							const returnType = this.lookupReturnType(init.callee.name);
							if (returnType) {
								declarationType = returnType;
							}
						}
					}
				}
				const type = typeMap[declarationType];
				if (!type) {
					throw new Error(`type ${ declarationType } not handled`);
				}
				retArr.push(type + ' ');
			}
			this.declarations[declaration.id.name] = declarationType;
			retArr.push.apply(retArr, retDeclaration);
		}
		retArr.push(';');
		return retArr;
	}

	/**
	 * @desc Parses the abstract syntax tree for *Variable Declarator*
	 * @param {Object} iVarDecNode - An ast Node
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astVariableDeclarator(iVarDecNode, retArr) {
		this.astGeneric(iVarDecNode.id, retArr);
		if (iVarDecNode.init !== null) {
			retArr.push('=');
			this.astGeneric(iVarDecNode.init, retArr);
		}
		return retArr;
	}

	/**
	 * @desc Parses the abstract syntax tree for *If* Statement
	 * @param {Object} ifNode - An ast Node
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astIfStatement(ifNode, retArr) {
		retArr.push('if (');
		this.astGeneric(ifNode.test, retArr);
		retArr.push(')');
		if (ifNode.consequent.type === 'BlockStatement') {
			this.astGeneric(ifNode.consequent, retArr);
		} else {
			retArr.push(' {\n');
			this.astGeneric(ifNode.consequent, retArr);
			retArr.push('\n}\n');
		}

		if (ifNode.alternate) {
			retArr.push('else ');
			if (ifNode.alternate.type === 'BlockStatement') {
				this.astGeneric(ifNode.alternate, retArr);
			} else {
				retArr.push(' {\n');
				this.astGeneric(ifNode.alternate, retArr);
				retArr.push('\n}\n');
			}
		}
		return retArr;

	}

	/**
	 * @desc Parses the abstract syntax tree for *Break* Statement
	 * @param {Object} brNode - An ast Node
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astBreakStatement(brNode, retArr) {
		retArr.push('break;\n');
		return retArr;
	}

	/**
	 * @desc Parses the abstract syntax tree for *Continue* Statement
	 * @param {Object} crNode - An ast Node
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astContinueStatement(crNode, retArr) {
		retArr.push('continue;\n');
		return retArr;
	}

	/**
	 * @desc Parses the abstract syntax tree for *Logical* Expression
	 * @param {Object} logNode - An ast Node
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astLogicalExpression(logNode, retArr) {
		retArr.push('(');
		this.astGeneric(logNode.left, retArr);
		retArr.push(logNode.operator);
		this.astGeneric(logNode.right, retArr);
		retArr.push(')');
		return retArr;
	}

	/**
	 * @desc Parses the abstract syntax tree for *Update* Expression
	 * @param {Object} uNode - An ast Node
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astUpdateExpression(uNode, retArr) {
		if (uNode.prefix) {
			retArr.push(uNode.operator);
			this.astGeneric(uNode.argument, retArr);
		} else {
			this.astGeneric(uNode.argument, retArr);
			retArr.push(uNode.operator);
		}

		return retArr;
	}

	/**
	 * @desc Parses the abstract syntax tree for *Unary* Expression
	 * @param {Object} uNode - An ast Node
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astUnaryExpression(uNode, retArr) {
		if (uNode.prefix) {
			retArr.push(uNode.operator);
			this.astGeneric(uNode.argument, retArr);
		} else {
			this.astGeneric(uNode.argument, retArr);
			retArr.push(uNode.operator);
		}

		return retArr;
	}

	/**
	 * @desc Parses the abstract syntax tree for *This* expression
	 * @param {Object} tNode - An ast Node
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astThisExpression(tNode, retArr) {
		retArr.push('this');
		return retArr;
	}

	/**
	 * @desc Parses the abstract syntax tree for *Member* Expression
	 * @param {Object} mNode - An ast Node
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astMemberExpression(mNode, retArr) {
		if (mNode.computed) {
			if (mNode.object.type === 'Identifier' ||
				(
					mNode.object.type === 'MemberExpression' &&
					// mNode.object.object &&
					mNode.object.object.object &&
					mNode.object.object.object.type === 'ThisExpression' &&
					mNode.object.object.property.name === 'constants'
				)
			) {
				// Working logger
				const reqName = mNode.object.name;
				let assumeNotTexture = false;

				// Possibly an array request - handle it as such
				if (this.argumentNames) {
					const idx = this.argumentNames.indexOf(reqName);
					if (idx >= 0 && this.argumentTypes[idx] === 'Number') {
						assumeNotTexture = true;
					}
				}
				if (assumeNotTexture) {
					// Get from array
					this.astGeneric(mNode.object, retArr);
					retArr.push('[int(');
					this.astGeneric(mNode.property, retArr);
					retArr.push(')]');
				} else {
					const isInGetParams = this.isState('in-get-call-parameters');
					const multiMemberExpression = this.isState('multi-member-expression');
					if (multiMemberExpression) {
						this.popState('multi-member-expression');
					}
					this.pushState('not-in-get-call-parameters');

					// This normally refers to the global read only input vars
					let variableType = null;
					if (mNode.object.name) {
						if (this.declarations[mNode.object.name]) {
							variableType = this.declarations[mNode.object.name];
						} else {
							variableType = this.getVariableType(mNode.object.name);
						}
					} else if (
						mNode.object &&
						mNode.object.object &&
						mNode.object.object.object &&
						mNode.object.object.object.type === 'ThisExpression'
					) {
						variableType = this.getConstantType(mNode.object.property.name);
					}
					switch (variableType) {
						case 'Array(2)':
						case 'Array(3)':
						case 'Array(4)':
							// Get from local vec4
							this.astGeneric(mNode.object, retArr);
							retArr.push('[');
							retArr.push(mNode.property.raw);
							retArr.push(']');
							if (multiMemberExpression) {
								this.popState('not-in-get-call-parameters');
							}
							break;
						case 'HTMLImageArray':
							// Get from image
							retArr.push('getImage3D(');
							this.astGeneric(mNode.object, retArr);
							retArr.push(', ');
							this.astGeneric(mNode.object, retArr);
							retArr.push('Size, ');
							this.astGeneric(mNode.object, retArr);
							retArr.push('Dim, ');
							this.popState('not-in-get-call-parameters');
							this.pushState('in-get-call-parameters');
							this.astGeneric(mNode.property, retArr);
							if (!multiMemberExpression) {
								this.popState('in-get-call-parameters');
							}
							retArr.push(')');
							break;
						case 'ArrayTexture(4)':
						case 'HTMLImage':
							// Get from image
							retArr.push('getImage2D(');
							this.astGeneric(mNode.object, retArr);
							retArr.push(', ');
							this.astGeneric(mNode.object, retArr);
							retArr.push('Size, ');
							this.astGeneric(mNode.object, retArr);
							retArr.push('Dim, ');
							this.popState('not-in-get-call-parameters');
							this.pushState('in-get-call-parameters');
							this.astGeneric(mNode.property, retArr);
							if (!multiMemberExpression) {
								this.popState('in-get-call-parameters');
							}
							retArr.push(')');
							break;
						default:
							// Get from texture
							if (isInGetParams) {
								retArr.push('int(');
							}
							retArr.push('get(');
							this.astGeneric(mNode.object, retArr);
							retArr.push(', ');
							this.astGeneric(mNode.object, retArr);
							retArr.push('Size, ');
							this.astGeneric(mNode.object, retArr);
							retArr.push('Dim, ');
							this.astGeneric(mNode.object, retArr);
							retArr.push('BitRatio, ');
							this.popState('not-in-get-call-parameters');
							this.pushState('in-get-call-parameters');
							this.astGeneric(mNode.property, retArr);
							if (!multiMemberExpression) {
								this.popState('in-get-call-parameters');
							}
							retArr.push(')');
							if (isInGetParams) {
								retArr.push(')');
							}
							break;
					}
				}
			} else {
				const startedInGetParamsState = this.isState('in-get-call-parameters');
				if (!startedInGetParamsState) {
					this.pushState('multi-member-expression');
				}
				this.astGeneric(mNode.object, retArr);
				if (this.isState('multi-member-expression')) {
					this.popState('multi-member-expression');
				}
				const changedGetParamsState = !startedInGetParamsState && this.isState('in-get-call-parameters');
				const last = retArr.pop();
				retArr.push(', ');
				const shouldPopParamState = this.isState('should-pop-in-get-call-parameters');
				if (shouldPopParamState) {
					// go back to in-get-call-parameters state
					this.popState('should-pop-in-get-call-parameters');
				}
				this.astGeneric(mNode.property, retArr);
				retArr.push(last);

				if (changedGetParamsState) {
					// calling memberExpression should pop...
					this.pushState('should-pop-in-get-call-parameters');
				} else if (shouldPopParamState) {
					// do the popping!
					this.popState('in-get-call-parameters')
				}
			}
		} else {

			// Unroll the member expression
			let unrolled = this.astMemberExpressionUnroll(mNode);
			let unrolled_lc = unrolled.toLowerCase();
			// Its a constant, remove this.constants.
			if (unrolled.indexOf(constantsPrefix) === 0) {
				const propertyName = unrolled.slice(constantsPrefix.length);
				const isIntegerComparison = this.isState('integer-comparison');
				if (!isIntegerComparison && this.constantTypes && this.constantTypes[propertyName] === 'Integer') {
					unrolled = 'float(constants_' + propertyName + ')';
				} else {
					unrolled = 'constants_' + propertyName;
				}
			}

			// do we need to cast addressing vales to float?
			const castFloat = !this.isState('in-get-call-parameters');
			const isIntegerComparison = this.isState('integer-comparison');
			switch (unrolled_lc) {
				case 'this.thread.x':
					if (castFloat) {
						retArr.push('float(threadId.x)');
					} else {
						retArr.push('threadId.x');
					}
					break;
				case 'this.thread.y':
					if (castFloat) {
						retArr.push('float(threadId.y)');
					} else {
						retArr.push('threadId.y');
					}
					break;
				case 'this.thread.z':
					if (castFloat) {
						retArr.push('float(threadId.z)');
					} else {
						retArr.push('threadId.z');
					}
					break;
				case 'this.output.x':
					if (isIntegerComparison) {
						retArr.push(this.output[0]);
					} else {
						retArr.push(this.output[0] + '.0');
					}
					break;
				case 'this.output.y':
					if (isIntegerComparison) {
						retArr.push(this.output[1]);
					} else {
						retArr.push(this.output[1] + '.0');
					}
					break;
				case 'this.output.z':
					if (isIntegerComparison) {
						retArr.push(this.output[2]);
					} else {
						retArr.push(this.output[2] + '.0');
					}
					break;
				default:
					if (
						mNode.object &&
						mNode.object.name &&
						this.declarations[mNode.object.name]) {
						retArr.push('user_');
					}
					retArr.push(unrolled);
			}
		}
		return retArr;
	}

	astSequenceExpression(sNode, retArr) {
		for (let i = 0; i < sNode.expressions.length; i++) {
			if (i > 0) {
				retArr.push(',');
			}
			this.astGeneric(sNode.expressions, retArr);
		}
		return retArr;
	}

	/**
	 * @desc Parses the abstract syntax tree for *call* expression
	 * @param {Object} ast - the AST object to parse
	 * @param {Array} retArr - return array string
	 * @returns  {Array} the append retArr
	 */
	astCallExpression(ast, retArr) {
		if (ast.callee) {
			// Get the full function call, unrolled
			let funcName = this.astMemberExpressionUnroll(ast.callee);

			// Its a math operator, remove the prefix
			if (funcName.indexOf(jsMathPrefix) === 0) {
				funcName = funcName.slice(jsMathPrefix.length);
			}

			// Its a local function, remove this
			if (funcName.indexOf(localPrefix) === 0) {
				funcName = funcName.slice(localPrefix.length);
			}

			// if this if grows to more than one, lets use a switch
			if (funcName === 'atan2') {
				funcName = 'atan';
			}

			// Register the function into the called registry
			if (this.calledFunctions.indexOf(funcName) < 0) {
				this.calledFunctions.push(funcName);
			}
			if (!this.hasOwnProperty('funcName')) {
				this.calledFunctionsArguments[funcName] = [];
			}

			const functionArguments = [];
			this.calledFunctionsArguments[funcName].push(functionArguments);

			if (funcName === 'random' && this.plugins) {
				for (let i = 0; i < this.plugins.length; i++) {
					const plugin = this.plugins[i];
					if (plugin.functionMatch === 'Math.random()' && plugin.functionReplace) {
						functionArguments.push(plugin.functionReturnType);
						retArr.push(plugin.functionReplace);
					}
				}
				return retArr;
			}

			// Call the function
			retArr.push(funcName);

			// Open arguments space
			retArr.push('(');

			// Add the vars
			for (let i = 0; i < ast.arguments.length; ++i) {
				const argument = ast.arguments[i];
				if (i > 0) {
					retArr.push(', ');
				}
				this.astGeneric(argument, retArr);
				if (argument.type === 'Identifier') {
					const argumentIndex = this.argumentNames.indexOf(argument.name);
					if (argumentIndex === -1) {
						functionArguments.push(null);
					} else {
						functionArguments.push({
							name: argument.name,
							type: this.argumentTypes[argumentIndex] || 'Number'
						});
					}
				} else {
					functionArguments.push(null);
				}
			}

			// Close arguments space
			retArr.push(')');

			return retArr;
		}

		// Failure, unknown expression
		throw this.astErrorOutput(
			'Unknown CallExpression',
			ast
		);
	}

	/**
	 * @desc Parses the abstract syntax tree for *Array* Expression
	 * @param {Object} arrNode - the AST object to parse
	 * @param {Array} retArr - return array string
	 * @returns {Array} the append retArr
	 */
	astArrayExpression(arrNode, retArr) {
		const arrLen = arrNode.elements.length;

		retArr.push('vec' + arrLen + '(');
		for (let i = 0; i < arrLen; ++i) {
			if (i > 0) {
				retArr.push(', ');
			}
			const subNode = arrNode.elements[i];
			this.astGeneric(subNode, retArr)
		}
		retArr.push(')');

		return retArr;
	}

	/**
	 * @function
	 * @name pushParameter
	 *
	 * @desc [INTERNAL] pushes a source parameter onto retArr and 'casts' to int if necessary
	 *  i.e. deal with force-int-parameter state
	 *
	 * @param {Array} retArr - return array string
	 * @param {String} name - the parameter name
	 *
	 */
	pushParameter(retArr, name) {
		const type = this.getVariableType(name);
		if (this.isState('in-get-call-parameters') || this.isState('integer-comparison')) {
			if (type !== 'Integer' && type !== 'Array') {
				retArr.push(`int(user_${name})`);
				return;
			}
		}

		retArr.push(`user_${name}`);
	}


	/**
	 *
	 * @param ast
	 * @returns {string|null}
	 */
	astGetFirstAvailableName(ast) {
		if (ast.name) {
			return ast.name;
		}
		return null;
	}

	build() {
		return this.toString().length > 0;
	}
}

const typeMap = {
	'Array': 'sampler2D',
	'Array(2)': 'vec2',
	'Array(3)': 'vec3',
	'Array(4)': 'vec4',
	'Array2D': 'sampler2D',
	'Array3D': 'sampler2D',
	'Float': 'float',
	'Input': 'sampler2D',
	'Integer': 'int',
	'Number': 'float',
	'NumberTexture': 'sampler2D',
	'ArrayTexture(4)': 'sampler2D'
};

const typeLookupMap = {
	'Array': 'Number',
	'Array2D': 'Number',
	'Array3D': 'Number',
	'HTMLImage': 'Array(4)',
	'HTMLImageArray': 'Array(4)',
	'NumberTexture': 'Number',
	'ArrayTexture(4)': 'Array(4)',
};

/**
 * @ignore
 * @function
 * @name webgl_regex_optimize
 *
 * @desc [INTERNAL] Takes the near final webgl function string, and do regex search and replacments.
 * For voodoo optimize out the following:
 *
 * - decode32(encode32( <br>
 * - encode32(decode32( <br>
 *
 * @param {String} inStr - The webGl function String
 *
 */
function webGlRegexOptimize(inStr) {
	return inStr
		.replace(DECODE32_ENCODE32, '((')
		.replace(ENCODE32_DECODE32, '((');
}

module.exports = {
	WebGLFunctionNode
};
