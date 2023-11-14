import { BadRequestException, Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { InjectRepository } from '@nestjs/typeorm'
import dayjs from 'dayjs'
import { Algorithm } from 'insertionfinder'
import { IPaginationOptions, paginate, Pagination } from 'nestjs-typeorm-paginate'
import { Repository } from 'typeorm'

import { SubmitSolutionDto } from '@/dtos/submit-solution.dto'
import {
  CompetitionFormat,
  CompetitionMode,
  Competitions,
  CompetitionStatus,
  CompetitionType,
} from '@/entities/competitions.entity'
import { DNF, DNS, Results } from '@/entities/results.entity'
import { Scrambles } from '@/entities/scrambles.entity'
import { Submissions } from '@/entities/submissions.entity'
import { Users } from '@/entities/users.entity'
import { formatSkeleton, generateScrambles, parseWeek } from '@/utils'

import { CompetitionService } from '../competition.service'

@Injectable()
export class WeeklyService {
  constructor(
    @InjectRepository(Competitions)
    private readonly competitionsRepository: Repository<Competitions>,
    @InjectRepository(Scrambles)
    private readonly scramblesRepository: Repository<Scrambles>,
    @InjectRepository(Submissions)
    private readonly submissionsRepository: Repository<Submissions>,
    @InjectRepository(Results)
    private readonly resultsRepository: Repository<Results>,
    private readonly competitionService: CompetitionService,
  ) {}

  @Cron('0 0 * * 1')
  // generate weekly competition on Monday 00:00
  async generateCompetition() {
    const competition = new Competitions()
    const week = dayjs().day(1).hour(0).minute(0).second(0).millisecond(0)
    const count = await this.competitionsRepository.countBy({
      type: CompetitionType.WEEKLY,
      startTime: week.toDate(),
    })
    if (count > 0) {
      return
    }
    competition.name = `Weekly ${week.format('YYYY-ww')}`
    competition.startTime = week.toDate()
    competition.endTime = week.add(1, 'week').toDate()
    competition.type = CompetitionType.WEEKLY
    competition.format = CompetitionFormat.MO3
    competition.userId = 1
    competition.status = CompetitionStatus.ON_GOING
    await this.competitionsRepository.save(competition)
    const scrambles: Scrambles[] = generateScrambles(3).map((str, number) => {
      const scramble = new Scrambles()
      scramble.number = number + 1
      scramble.scramble = str
      scramble.competitionId = competition.id
      return scramble
    })
    await this.scramblesRepository.save(scrambles)
  }

  getOnGoing() {
    return this.competitionService.findOne({
      where: {
        type: CompetitionType.WEEKLY,
        status: CompetitionStatus.ON_GOING,
      },
      relations: {
        scrambles: true,
      },
      order: {
        id: 'DESC',
      },
    })
  }

  async getCompetitions(options: IPaginationOptions): Promise<Pagination<Competitions>> {
    const data = await paginate<Competitions>(this.competitionsRepository, options, {
      where: {
        type: CompetitionType.WEEKLY,
        status: CompetitionStatus.ENDED,
      },
      order: {
        createdAt: 'DESC',
      },
    })
    await Promise.all(
      data.items.map(async competition => {
        const winner = await this.resultsRepository.findOne({
          where: {
            competitionId: competition.id,
          },
          order: {
            average: 'ASC',
            best: 'ASC',
          },
          relations: {
            user: true,
          },
        })
        competition.winner = winner
      }),
    )
    return data
  }

  getCompetition(week: string) {
    // get date from week in format YYYY-ww
    const date = parseWeek(week)
    if (date === null) {
      return null
    }
    return this.competitionService.findOne({
      where: {
        type: CompetitionType.WEEKLY,
        startTime: date.toDate(),
      },
      relations: {
        scrambles: true,
      },
    })
  }

  async getResults(competition: Competitions, mode: CompetitionMode) {
    const results = await this.resultsRepository.find({
      where: {
        mode,
        competitionId: competition.id,
      },
      order: {
        average: 'ASC',
        best: 'ASC',
      },
      relations: {
        user: true,
      },
    })
    return results
  }

  async submitSolution(competition: Competitions, user: Users, solution: SubmitSolutionDto) {
    if (competition.hasEnded) {
      throw new BadRequestException('Competition has ended')
    }
    const scramble = await this.scramblesRepository.findOne({
      where: {
        id: solution.scrambleId,
      },
    })
    if (scramble === null) {
      throw new BadRequestException('Invalid scramble')
    }
    const preSubmissions = await this.submissionsRepository.find({
      where: {
        scrambleId: scramble.id,
        userId: user.id,
      },
    })

    // regular mode can only submit once
    if (solution.mode === CompetitionMode.REGULAR) {
      if (preSubmissions.length > 0) {
        throw new BadRequestException('Already submitted')
      }
    }
    const preSubmission = preSubmissions.find(s => s.mode === solution.mode)
    const submission = preSubmission || new Submissions()
    submission.competition = competition
    submission.mode = solution.mode
    submission.scramble = scramble
    submission.user = user
    submission.solution = solution.solution
    submission.comment = solution.comment
    let moves: number = DNS
    try {
      const { bestCube } = formatSkeleton(scramble.scramble, solution.solution)
      // check if solved
      if (
        bestCube.getCornerCycles() === 0 &&
        bestCube.getEdgeCycles() === 0 &&
        bestCube.getCenterCycles() === 0 &&
        !bestCube.hasParity()
      ) {
        const solutionAlg = new Algorithm(solution.solution)
        moves = (solutionAlg.twists.length + solutionAlg.inverseTwists.length) * 100
      } else {
        // DNF
        moves = DNF
      }
      // check NISS and ()
      if (solution.solution.includes('NISS') || solution.solution.includes('(')) {
        moves = DNF
      }
    } catch (e) {
      moves = DNF
    }
    // check if moves is better than preSubmission
    if (solution.mode === CompetitionMode.UNLIMITED && preSubmissions.some(s => s.moves < moves)) {
      throw new BadRequestException('Solution is not better than previous submission')
    }
    submission.moves = moves
    let result = await this.resultsRepository.findOne({
      where: {
        mode: solution.mode,
        competition: {
          id: competition.id,
        },
        user: {
          id: user.id,
        },
      },
    })
    if (result === null) {
      result = new Results()
      result.mode = solution.mode
      result.competition = competition
      result.user = user
      result.values = competition.scrambles.map(() => 0)
      result.best = 0
      result.average = 0
      await this.resultsRepository.save(result)
    }
    submission.result = result
    await this.submissionsRepository.save(submission)
    result.values[scramble.number - 1] = submission.moves
    const nonZeroValues = result.values.filter(value => value > 0)
    result.best = Math.min(...nonZeroValues)
    result.average = Math.round(nonZeroValues.reduce((a, b) => a + b, 0) / nonZeroValues.length)
    if (result.values.some(v => v === DNF || v === DNS)) {
      result.average = DNF
    }
    await this.resultsRepository.save(result)
    return submission
  }

  async updateComment(
    competition: Competitions,
    user: Users,
    id: number,
    solution: Pick<SubmitSolutionDto, 'comment'>,
  ) {
    const submission = await this.submissionsRepository.findOne({
      where: {
        id,
        userId: user.id,
        competitionId: competition.id,
      },
    })
    if (submission === null) {
      throw new BadRequestException('Invalid submission')
    }
    submission.comment = solution.comment
    await this.submissionsRepository.save(submission)
  }

  async turnToUnlimited(competition: Competitions, user: Users, id: number) {
    const submission = await this.submissionsRepository.findOne({
      where: {
        id,
        mode: CompetitionMode.REGULAR,
        userId: user.id,
        competitionId: competition.id,
      },
      relations: {
        scramble: true,
        result: true,
      },
    })
    if (submission === null) {
      throw new BadRequestException('Invalid submission')
    }
    const unlimitedSubmission = await this.submissionsRepository.findOne({
      where: {
        scrambleId: submission.scrambleId,
        mode: CompetitionMode.UNLIMITED,
        userId: user.id,
        competitionId: competition.id,
      },
    })
    if (unlimitedSubmission) {
      throw new BadRequestException('Already submitted')
    }
    submission.mode = CompetitionMode.UNLIMITED
    // DNF regular result
    const regularResult = submission.result
    regularResult.values[submission.scramble.number - 1] = DNF
    regularResult.best = Math.min(...regularResult.values.filter(v => v > 0))
    regularResult.average = DNF
    await this.resultsRepository.save(regularResult)
    // update unlimited result
    let unlimitedResult = await this.resultsRepository.findOne({
      where: {
        mode: CompetitionMode.UNLIMITED,
        competitionId: competition.id,
        userId: user.id,
      },
    })
    if (unlimitedResult === null) {
      unlimitedResult = new Results()
      unlimitedResult.mode = CompetitionMode.UNLIMITED
      unlimitedResult.competition = competition
      unlimitedResult.user = user
      unlimitedResult.values = competition.scrambles.map(() => 0)
      unlimitedResult.best = 0
      unlimitedResult.average = 0
    }
    unlimitedResult.values[submission.scramble.number - 1] = submission.moves
    const nonZeroValues = unlimitedResult.values.filter(value => value > 0)
    unlimitedResult.best = Math.min(...nonZeroValues)
    unlimitedResult.average = Math.round(nonZeroValues.reduce((a, b) => a + b, 0) / nonZeroValues.length)
    if (unlimitedResult.values.some(v => v === DNF || v === DNS)) {
      unlimitedResult.average = DNF
    }
    await this.resultsRepository.save(unlimitedResult)
    submission.result = unlimitedResult
    await this.submissionsRepository.save(submission)
  }

  async getSubmissions(competition: Competitions) {
    const submissions = await this.submissionsRepository.find({
      where: {
        competitionId: competition.id,
      },
      order: {
        moves: 'ASC',
      },
      relations: {
        user: true,
      },
    })
    return submissions
  }
}
