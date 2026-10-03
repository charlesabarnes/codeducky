import './buffer'
import { expose } from 'comlink'
import { createGitService } from './service'

expose(createGitService())
